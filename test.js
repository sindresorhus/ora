/* eslint max-lines: "off" -- the fake terminal and the tests are easier to follow in one file */
/* eslint node-test/require-mock-timers-advance: "off" -- mocked timers mostly keep the interval from firing, and only some tests tick them */
/* eslint node-test/no-conditional-assertion: "off" -- table tests assert once per row inside the loop */
import {Buffer} from 'node:buffer';
import process from 'node:process';
import {PassThrough as PassThroughStream} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import getStream from 'get-stream';
import ora, {oraPromise, spinners} from './index.js';

const spinnerCharacter = process.platform === 'win32' ? '-' : '⠋';
const synchronizedOutputEnable = '\u{1B}[?2026h';
const synchronizedOutputDisable = '\u{1B}[?2026l';
const noop = () => {};
const ansiEscape = '\u{1B}';
// eslint-disable-next-line regexp/no-control-character -- the escape character is the subject
const ansiControlSequence = new RegExp(String.raw`${ansiEscape}\[[\d;?]*[A-Za-z]`, 'gv');
// eslint-disable-next-line regexp/no-control-character -- the escape character is the subject
const ansiControlSequenceAtStart = new RegExp(String.raw`^${ansiEscape}\[[\d;?]*[A-Za-z]`, 'v');
// eslint-disable-next-line regexp/no-control-character -- the escape character is the subject
const clearSequencePattern = new RegExp(String.raw`${ansiEscape}\[[0-2]?K|${ansiEscape}\[[0-2]?J`, 'v');

class TerminalState {
	#columns;
	#maxRows;
	#lines = [''];
	#cursorX = 0;
	#cursorY = 0;
	#trailingNewline = false;

	constructor({columns = 80, rows = undefined} = {}) {
		this.#columns = columns;
		this.#maxRows = rows;
	}

	#applyAnsiSequence(sequence) {
		if (sequence.startsWith('\u{1B}[?')) {
			return;
		}

		const finalCharacter = sequence.at(-1);
		const rawParameters = sequence.slice(2, -1);
		const parameters = rawParameters === '' ? [] : rawParameters.split(';').map(Number);

		if (finalCharacter === 'G') {
			this.#cursorX = Math.max(0, (parameters[0] ?? 1) - 1);
			this.#trailingNewline = false;
			return;
		}

		if (finalCharacter === 'A') {
			this.#cursorY = Math.max(0, this.#cursorY - (parameters[0] ?? 1));
			this.#trailingNewline = false;
			return;
		}

		if (finalCharacter === 'B') {
			this.#cursorY += parameters[0] ?? 1;
			this.#ensureCursorLine();
			this.#trailingNewline = false;
			return;
		}

		if (finalCharacter === 'C') {
			this.#cursorX += parameters[0] ?? 1;
			this.#trailingNewline = false;
			return;
		}

		if (finalCharacter === 'D') {
			this.#cursorX = Math.max(0, this.#cursorX - (parameters[0] ?? 1));
			this.#trailingNewline = false;
			return;
		}

		if (finalCharacter === 'K') {
			this.#clearLine(parameters[0] ?? 0);
		}
	}

	#clearLine(mode) {
		this.#ensureCursorLine();
		const line = this.#lines[this.#cursorY];

		if (mode === 1) {
			this.#lines[this.#cursorY] = ' '.repeat(this.#cursorX) + line.slice(this.#cursorX);
			return;
		}

		if (mode === 2) {
			this.#lines[this.#cursorY] = '';
			return;
		}

		this.#lines[this.#cursorY] = line.slice(0, this.#cursorX);
	}

	#writeCharacter(character) {
		if (character === '\r') {
			this.#cursorX = 0;
			this.#trailingNewline = false;
			return;
		}

		if (character === '\n') {
			this.#cursorX = 0;
			this.#cursorY++;
			this.#ensureCursorLine();
			this.#trailingNewline = true;
			this.#scrollIfNeeded();
			return;
		}

		this.#ensureCursorLine();
		this.#trailingNewline = false;

		if (this.#cursorX >= this.#columns) {
			this.#cursorX = 0;
			this.#cursorY++;
			this.#ensureCursorLine();
			this.#scrollIfNeeded();
		}

		const line = this.#lines[this.#cursorY];
		const paddedLine = line.padEnd(this.#cursorX, ' ');
		this.#lines[this.#cursorY] = paddedLine.slice(0, this.#cursorX) + character + paddedLine.slice(this.#cursorX + 1);
		this.#cursorX++;
	}

	// A real terminal scrolls once the cursor moves past the last row
	#scrollIfNeeded() {
		if (this.#maxRows === undefined || this.#cursorY < this.#maxRows) {
			return;
		}

		this.#lines.shift();
		this.#cursorY--;
	}

	#ensureCursorLine() {
		while (this.#lines.length <= this.#cursorY) {
			this.#lines.push('');
		}
	}

	get cursorPosition() {
		return {
			x: this.#cursorX,
			y: this.#cursorY,
		};
	}

	clear() {
		this.#lines = [''];
		this.#cursorX = 0;
		this.#cursorY = 0;
		this.#trailingNewline = false;
	}

	// Resize existing cells without reflowing the cursor line, as xterm.js does by default
	resize(columns) {
		this.#columns = columns;
		this.#cursorX = Math.min(this.#cursorX, columns - 1);
		this.#lines = this.#lines.map(line => line.slice(0, columns));
	}

	write(content) {
		let index = 0;

		while (index < content.length) {
			const character = content[index];

			if (character === '\u{1B}') {
				const sequence = content.slice(index).match(ansiControlSequenceAtStart)?.[0];
				if (sequence) {
					this.#applyAnsiSequence(sequence);
					index += sequence.length;
					continue;
				}
			}

			index++;
			this.#writeCharacter(character);
		}
	}

	toString() {
		let lastIndex = this.#lines.length - 1;
		while (lastIndex > 0 && this.#lines[lastIndex] === '') {
			lastIndex--;
		}

		const result = this.#lines.slice(0, lastIndex + 1).join('\n');
		return this.#trailingNewline ? result + '\n' : result;
	}
}

class LocalTransformTTY extends PassThroughStream {
	static onlyAnsi(string) {
		return string.replaceAll('\u{7}', '').replaceAll(ansiControlSequence, '') === '';
	}

	#rows;
	#columns;
	#chunks = [];
	#state;
	#sequencers = [];

	constructor({rows = 25, columns = 80} = {}) {
		super();
		this.#rows = rows;
		this.#columns = columns;
		this.#state = new TerminalState({columns, rows});
		this.isTTY = true;
	}

	get rows() {
		return this.#rows;
	}

	set rows(rows) {
		this.#rows = rows;
	}

	get columns() {
		return this.#columns;
	}

	set columns(columns) {
		this.#columns = columns;
		this.#state = new TerminalState({columns, rows: this.#rows});
		for (const chunk of this.#chunks) {
			this.#state.write(chunk);
		}

		for (const sequencer of this.#sequencers) {
			sequencer.state = new TerminalState({columns});
			for (const chunk of sequencer.currentSequence) {
				sequencer.state.write(chunk);
			}
		}
	}

	write(content, encoding, callback) {
		const string = Buffer.isBuffer(content) ? content.toString() : String(content);
		this.#chunks.push(string);
		this.#state.write(string);

		for (const sequencer of this.#sequencers) {
			sequencer.currentSequence.push(string);
			sequencer.state.write(string);
			sequencer.lastSequence = [...sequencer.currentSequence];

			if (!sequencer.add(string, sequencer)) {
				continue;
			}

			sequencer.sequences.push([...sequencer.currentSequence]);
			sequencer.frames.push(sequencer.state.toString());

			if (!sequencer.clear(string, sequencer)) {
				continue;
			}

			sequencer.currentSequence = [];
			sequencer.state.clear();
		}

		return super.write(content, encoding, callback);
	}

	addSequencer(add, shouldClear = false) {
		add ||= string => !LocalTransformTTY.onlyAnsi(string);

		shouldClear &&= (_string, sequencer) => sequencer.currentSequence.some(sequence => clearSequencePattern.test(sequence));

		if (typeof shouldClear !== 'function') {
			shouldClear = () => false;
		}

		this.#sequencers.push({
			add,
			clear: shouldClear,
			currentSequence: [],
			lastSequence: [],
			sequences: [],
			frames: [],
			state: new TerminalState({columns: this.#columns}),
		});
	}

	getCursorPos() {
		return this.#state.cursorPosition;
	}

	getFrames() {
		return this.#sequencers.length === 1 ? this.#sequencers[0].frames : this.#sequencers.map(sequencer => sequencer.frames);
	}

	getSequenceStrings() {
		const frames = this.getFrames();
		return this.#sequencers.length === 1 ? frames.at(-1) : frames.map(sequencerFrames => sequencerFrames.at(-1));
	}

	toString() {
		return this.#state.toString();
	}

	clearLine(direction = 0) {
		if (direction === 1) {
			this.write('\u{1B}[K');
			return;
		}

		if (direction === -1) {
			this.write('\u{1B}[1K');
			return;
		}

		this.write('\u{1B}[2K');
	}

	moveCursor(dx, dy) {
		if (dx > 0) {
			this.write(`\u{1B}[${dx}C`);
		} else if (dx < 0) {
			this.write(`\u{1B}[${Math.abs(dx)}D`);
		}

		if (dy > 0) {
			this.write(`\u{1B}[${dy}B`);
		} else if (dy < 0) {
			this.write(`\u{1B}[${Math.abs(dy)}A`);
		}
	}

	cursorTo(x) {
		this.write(`\u{1B}[${x + 1}G`);
	}
}

const getLastSynchronizedOutput = output => {
	const lastEnableIndex = output.lastIndexOf(synchronizedOutputEnable);
	if (lastEnableIndex === -1) {
		return output;
	}

	const disableIndex = output.indexOf(synchronizedOutputDisable, lastEnableIndex);
	return disableIndex === -1 ? output.slice(lastEnableIndex + synchronizedOutputEnable.length) : output.slice(lastEnableIndex + synchronizedOutputEnable.length, disableIndex);
};

const stripSynchronizedOutputSequences = content => typeof content === 'string' ? content.replaceAll(synchronizedOutputEnable, '').replaceAll(synchronizedOutputDisable, '') : content;

const applySynchronizedOutputFilter = stream => {
	const originalWrite = stream.write;
	stream.write = function (content, encoding, callback) {
		const filteredContent = stripSynchronizedOutputSequences(content);
		return filteredContent === '' ? true : originalWrite.call(this, filteredContent, encoding, callback);
	};

	return stream;
};

// The output as a terminal would show it: no escape codes, and every line ending normalized
const toScreen = output => stripVTControlCharacters(output).replaceAll('\r\n', '\n');

const getPassThroughStream = () => {
	const stream = new PassThroughStream();
	stream.clearLine = noop;
	stream.cursorTo = noop;
	stream.moveCursor = noop;
	return stream;
};

// A spinner on a fake terminal by default, stopped when the test ends
const createSpinner = (t, {columns, rows, stream = new LocalTransformTTY({columns, rows}), ...options} = {}) => {
	const spinner = ora({
		stream,
		color: false,
		isEnabled: true,
		discardStdin: false,
		...options,
	});

	t.after(() => {
		spinner.stop();
	});

	return {stream, spinner};
};

const withFakeStdin = (options = {}, callback) => {
	const {isPaused = false} = options;
	const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
	const fakeStdin = new PassThroughStream();
	const rawModeCalls = [];

	fakeStdin.isTTY = true;
	fakeStdin.isRaw = false;
	fakeStdin.setRawMode = value => {
		rawModeCalls.push(value);
		fakeStdin.isRaw = value;
	};

	if (isPaused) {
		fakeStdin.pause();
	}

	Object.defineProperty(process, 'stdin', {
		value: fakeStdin,
		configurable: true,
	});

	try {
		return callback({fakeStdin, rawModeCalls});
	} finally {
		Object.defineProperty(process, 'stdin', originalStdinDescriptor);
	}
};

// `is-unicode-supported` reports no Unicode for the Linux console
const withLinuxConsole = callback => {
	const originalTerm = process.env.TERM;
	process.env.TERM = 'linux';

	try {
		return callback();
	} finally {
		if (originalTerm === undefined) {
			delete process.env.TERM;
		} else {
			process.env.TERM = originalTerm;
		}
	}
};

// Seeded, so a failing property test reports the same input on every run
const seededRandom = seed => () => {
	seed = ((seed * 1_103_515_245) + 12_345) % 2_147_483_648;
	return seed / 2_147_483_648;
};

const doRawSpinner = async (function_, extraOptions = {}) => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		isSilent: false,
		...extraOptions,
	});

	spinner.start();
	function_(spinner);
	stream.end();

	return output;
};

// The output as a terminal would show it, so without the ansi escape codes
const doSpinner = async (function_, extraOptions = {}) => toScreen(await doRawSpinner(function_, extraOptions));

test('main', async () => {
	const result = await doSpinner(spinner => {
		spinner.stop();
	});
	assert.match(result, new RegExp(`${spinnerCharacter} foo`, 'v'));
});

test('render uses synchronized output sequences', async () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	spinner.render();
	stream.end();

	const result = await output;
	assert.ok(result.includes(synchronizedOutputEnable));
	assert.ok(result.includes(synchronizedOutputDisable));
	assert.ok(result.indexOf(synchronizedOutputEnable) < result.indexOf(synchronizedOutputDisable));

	const synchronizedOutput = getLastSynchronizedOutput(result);
	const renderedText = stripVTControlCharacters(synchronizedOutput);
	assert.ok(renderedText.includes(spinnerCharacter));
	assert.ok(renderedText.includes('foo'));
	assert.strictEqual(stripSynchronizedOutputSequences(result), synchronizedOutput);
});

test('`.isSpinning` is false when created', () => {
	const spinner = ora('foo');
	assert.ok(!spinner.isSpinning);
});

test('ignore consecutive calls to `.start()`', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {text: 'foo', interval: 100_000});
	spinner.start();
	spinner.start('bar');

	// Only the text is updated, and it shows on the next frame
	t.assert.strictEqual(spinner.text, 'bar');
	t.assert.strictEqual(stream.toString(), `${spinnerCharacter} foo`);

	t.mock.timers.tick(100_000);
	t.assert.ok(stream.toString().endsWith(' bar'));
});

test('chain call to `.start()` with constructor', () => {
	const spinner = ora({
		stream: getPassThroughStream(),
		text: 'foo',
		isEnabled: true,
	}).start();

	assert.ok(spinner.isSpinning);
	assert.ok(spinner._isEnabled);
	spinner.stop();
});

test('.succeed()', async () => {
	const result = await doSpinner(spinner => {
		spinner.succeed();
	});
	assert.match(result, /[√✔] foo\n$/v);
});

test('.succeed() - with new text', async () => {
	const result = await doSpinner(spinner => {
		spinner.succeed('fooed');
	});
	assert.match(result, /[√✔] fooed\n$/v);
});

test('.fail()', async () => {
	const result = await doSpinner(spinner => {
		spinner.fail();
	});
	assert.match(result, /[×✖] foo\n$/v);
});

test('.fail() - with new text', async () => {
	const result = await doSpinner(spinner => {
		spinner.fail('failed to foo');
	});
	assert.match(result, /[×✖] failed to foo\n$/v);
});

test('.warn()', async () => {
	const result = await doSpinner(spinner => {
		spinner.warn();
	});
	assert.match(result, /[‼⚠] foo\n$/v);
});

test('.info()', async () => {
	const result = await doSpinner(spinner => {
		spinner.info();
	});
	assert.match(result, /[iℹ] foo\n$/v);
});

test('.stopAndPersist() - with new text', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({text: 'all done'});
	});
	assert.match(result, /\s all done\n$/v);
});

test('.stopAndPersist() - with null or undefined options', async () => {
	// `options` is optional, so `null` has to behave like `undefined`
	for (const options of [null, undefined]) {
		// eslint-disable-next-line no-await-in-loop -- each spinner needs its own stream
		const result = await doSpinner(spinner => {
			spinner.stopAndPersist(options);
		});
		assert.match(result, /\s foo\n$/v);
	}
});

test('.stopAndPersist() - with new symbol and text', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'all done'});
	});
	assert.match(result, /@ all done\n$/v);
});

test('.start(text)', async () => {
	const result = await doSpinner(spinner => {
		spinner.start('Test text');
		spinner.stopAndPersist();
	});
	assert.match(result, /Test text\n$/v);
});

test('.start(text) accepts empty string', () => {
	const spinner = ora('foo');
	spinner.start('');
	assert.strictEqual(spinner.text, '');
	spinner.stop();
});

test('.start() - isEnabled:false outputs text', async () => {
	const result = await doSpinner(spinner => {
		spinner.stop();
	}, {isEnabled: false});
	assert.match(result, /- foo\n$/v);
});

test('.stopAndPersist() - isEnabled:false outputs text', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'all done'});
	}, {isEnabled: false});
	assert.match(result, /- foo\n@ all done\n$/v);
});

const assertNoAnsi = (result, name) => {
	assert.ok(!result.includes('\u{1B}['), `${name} should not emit ansi escape codes, got ${JSON.stringify(result)}`);
};

for (const [method, symbolPattern] of [
	['succeed', /[\u{221A}\u{2714}]/v],
	['fail', /[\u{D7}\u{2716}]/v],
	['warn', /[\u{203C}\u{26A0}]/v],
	['info', /[i\u{2139}]/v],
]) {
	test(`.${method}() - isEnabled:false emits no ansi escape codes`, async () => {
		// `log-symbols` bakes in color from the real stdout, so the symbol must be stripped for this stream
		const result = await doRawSpinner(spinner => {
			spinner[method]('all done');
		}, {isEnabled: false});

		assert.match(result, new RegExp(String.raw`- foo\n${symbolPattern.source} all done\n$`, 'v'));
		assertNoAnsi(result, `.${method}()`);
	});
}

test('a non-string symbol is stringified the same way on a stream that cannot render color', async () => {
	const result = await doRawSpinner(spinner => {
		// @ts-expect-error Intentional invalid type
		spinner.stopAndPersist({symbol: 42, text: 'done'});
	});

	assert.ok(result.endsWith('42 done\n'), `got ${JSON.stringify(result)}`);
});

test('.succeed() - a stream that cannot render colors gets an uncolored symbol', async t => {
	// The pass through stream is not a TTY, so it cannot render colors
	const result = await doRawSpinner(spinner => {
		spinner.succeed('all done');
	});

	// The whole frame is pinned, so a color escape anywhere in it fails here
	t.assert.match(result, new RegExp(String.raw`^${spinnerCharacter} foo[√✔] all done\n$`, 'v'));
});

test('.start() - isSilent:true no output', async () => {
	const result = await doSpinner(spinner => {
		spinner.stop();
	}, {isSilent: true});
	assert.match(result, /^$/v);
});

test('.stopAndPersist() - isSilent:true no output', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'all done'});
	}, {isSilent: true});
	assert.match(result, /^$/v);
});

test('.stopAndPersist() - isSilent:true can be disabled', async () => {
	const result = await doSpinner(spinner => {
		spinner.isSilent = false;
		spinner.stopAndPersist({symbol: '@', text: 'all done'});
	}, {isSilent: true});
	assert.match(result, /@ all done\n$/v);
});

test('.stopAndPersist() - stops the spinner when isSilent is set after start', async () => {
	const result = await doSpinner(spinner => {
		spinner.isSilent = true;
		spinner.succeed('all done');
		assert.strictEqual(spinner.isSpinning, false);
	});
	assert.doesNotMatch(result, /all done/v);
});

for (const [name, disable] of [
	['isEnabled', spinner => {
		spinner.isEnabled = false;
	}],
	['isSilent', spinner => {
		spinner.isSilent = true;
	}],
]) {
	test(`.stop() - shows the cursor when ${name} is changed after start`, async () => {
		const stream = getPassThroughStream();
		stream.isTTY = true;
		const output = getStream(stream);

		const spinner = ora({
			stream,
			text: 'foo',
			isEnabled: true,
		});

		spinner.start();
		disable(spinner);
		spinner.stop();
		stream.end();

		const result = await output;
		assert.ok(result.endsWith('\u{1B}[?25h'));
	});

	test(`.stop() - erases the rendered frame when ${name} is changed after start`, t => {
		const {stream, spinner} = createSpinner(t, {text: 'foo'});

		spinner.start();
		t.assert.strictEqual(stream.toString(), `${spinnerCharacter} foo`);

		disable(spinner);
		spinner.stop();

		// The frame is on screen, so it must be erased even though output is now disabled
		t.assert.strictEqual(stream.toString(), '');
	});
}

test('discardStdin toggles raw mode and data listeners on TTY stdin', () => {
	if (process.platform === 'win32') {
		return;
	}

	withFakeStdin({}, ({fakeStdin, rawModeCalls}) => {
		const spinner = ora({
			stream: getPassThroughStream(),
			text: 'foo',
			isEnabled: true,
		});
		const initialListenerCount = fakeStdin.listenerCount('data');

		spinner.start();
		assert.deepStrictEqual(rawModeCalls, [true]);
		assert.ok(fakeStdin.listenerCount('data') > initialListenerCount);

		spinner.stop();
		assert.deepStrictEqual(rawModeCalls, [true, false]);
		assert.strictEqual(fakeStdin.listenerCount('data'), initialListenerCount);
	});
});

test('start() does not show a cursor it never hid when the first render throws', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const writes = [];
	const originalWrite = stream.write;
	stream.write = function (...arguments_) {
		writes.push(String(arguments_[0]));
		return originalWrite.apply(this, arguments_);
	};

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		discardStdin: false,
		hideCursor: false,
		prefixText() {
			throw new Error('prefix boom');
		},
	});

	t.after(() => {
		spinner.stop();
		stream.end();
	});

	t.assert.throws(() => {
		spinner.start();
	}, {message: 'prefix boom'});

	// `hideCursor: false` means the cursor was never hidden, so it must not be shown either
	t.assert.ok(!writes.includes('\u{1B}[?25h'), 'the cursor is not shown when it was never hidden');
});

test('start() undoes what it did when the first render throws', t => {
	if (process.platform === 'win32') {
		return;
	}

	withFakeStdin({}, ({fakeStdin, rawModeCalls}) => {
		const stream = getPassThroughStream();
		stream.isTTY = true;
		const writes = [];
		const originalWrite = stream.write;
		stream.write = function (...arguments_) {
			writes.push(String(arguments_[0]));
			return originalWrite.apply(this, arguments_);
		};

		const initialListenerCount = fakeStdin.listenerCount('data');

		const spinner = ora({
			stream,
			text: 'foo',
			color: false,
			isEnabled: true,
			prefixText() {
				throw new Error('prefix boom');
			},
		});

		t.after(() => {
			spinner.stop();
			stream.end();
		});

		const writeBeforeStart = stream.write;

		t.assert.throws(() => {
			spinner.start();
		}, {message: 'prefix boom'});

		// `start()` hides the cursor, discards stdin, and hooks the stream before it renders, so a failed first render must undo all of it
		t.assert.strictEqual(spinner.isSpinning, false);
		t.assert.strictEqual(stream.write, writeBeforeStart, 'the stream hook is removed');
		t.assert.deepStrictEqual(rawModeCalls, [true, false], 'stdin raw mode is restored');
		t.assert.strictEqual(fakeStdin.listenerCount('data'), initialListenerCount, 'the stdin listener is removed');

		// Every hide has a matching show, so the cursor is not left invisible
		const hides = writes.filter(write => write === '\u{1B}[?25l').length;
		const shows = writes.filter(write => write === '\u{1B}[?25h').length;
		t.assert.strictEqual(hides, 1, 'the cursor was hidden once');
		t.assert.strictEqual(shows, 1, 'the cursor is shown again');
	});
});

test('discardStdin preserves stdin pause state', () => {
	if (process.platform === 'win32') {
		return;
	}

	const assertPauseStatePreserved = isPaused => {
		withFakeStdin({isPaused}, ({fakeStdin}) => {
			const spinner = ora({
				stream: getPassThroughStream(),
				text: 'foo',
				isEnabled: true,
			});
			const initialPausedState = fakeStdin.isPaused();

			spinner.start();
			spinner.stop();

			assert.strictEqual(fakeStdin.isPaused(), initialPausedState);
		});
	};

	assertPauseStatePreserved(false);
	assertPauseStatePreserved(true);
});

test('discardStdin re-signals Ctrl+C even when SIGINT listeners exist', () => {
	if (process.platform === 'win32') {
		return;
	}

	withFakeStdin({}, ({fakeStdin}) => {
		const stream = getPassThroughStream();
		let emittedSignal;
		let killedSignal;
		const originalListenerCount = process.listenerCount;
		const originalEmit = process.emit;
		const originalKill = process.kill;

		process.listenerCount = signal => signal === 'SIGINT' ? 1 : originalListenerCount.call(process, signal);
		process.emit = (event, ...arguments_) => {
			if (event === 'SIGINT') {
				emittedSignal = event;
				return true;
			}

			return originalEmit.call(process, event, ...arguments_);
		};

		process.kill = (processId, signal) => {
			killedSignal = {processId, signal};
			return true;
		};

		const spinner = ora({
			stream,
			text: 'foo',
			isEnabled: true,
		});

		try {
			spinner.start();
			fakeStdin.emit('data', Buffer.from([0x03]));
		} finally {
			spinner.stop();
			process.listenerCount = originalListenerCount;
			process.emit = originalEmit;
			process.kill = originalKill;
		}

		assert.strictEqual(emittedSignal, undefined);
		assert.deepStrictEqual(killedSignal, {processId: process.pid, signal: 'SIGINT'});
	});
});

test('oraPromise() - resolves', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const resolves = Promise.resolve(1);

	oraPromise(resolves, {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	await resolves;
	stream.end();

	assert.match(toScreen(await output), /[√✔] foo\n$/v);
});

test('oraPromise() - rejects', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const rejects = Promise.reject(new Error()); // eslint-disable-line unicorn/error-message

	try {
		await oraPromise(rejects, {
			stream,
			text: 'foo',
			color: false,
			isEnabled: true,
		});
	} catch {}

	stream.end();

	assert.match(toScreen(await output), /[×✖] foo\n$/v);
});

test('oraPromise() - failText throwing still stops the spinner and keeps the original error', async t => {
	const stream = getPassThroughStream();
	let writes = 0;
	const originalWrite = stream.write;
	stream.write = function (...arguments_) {
		writes++;
		return originalWrite.apply(this, arguments_);
	};

	await t.assert.rejects(
		oraPromise(spinner => {
			t.after(() => {
				spinner.stop();
			});

			throw new Error('action failed');
		}, {
			stream,
			text: 'foo',
			color: false,
			isEnabled: true,
			discardStdin: false,
			failText() {
				throw new Error('failText failed');
			},
		}),
		{message: 'action failed'},
	);

	const writesAfterReject = writes;
	await new Promise(resolve => {
		setTimeout(resolve, 200);
	});

	t.assert.strictEqual(writes, writesAfterReject, 'the spinner kept rendering after the rejection');
});

test('oraPromise() - a failing persist write keeps the original error', async () => {
	const stream = getPassThroughStream();
	const originalWrite = stream.write;
	stream.write = function (content, ...rest) {
		// The stream fails while the failure line is written
		if (String(content).includes('✖') || String(content).includes('×')) {
			throw new Error('stream EPIPE during persist');
		}

		return originalWrite.call(this, content, ...rest);
	};

	const failingAction = Promise.reject(new Error('the real action failure'));

	await assert.rejects(
		oraPromise(failingAction, {
			stream,
			text: 'foo',
			color: false,
			isEnabled: true,
			discardStdin: false,
		}),
		// The action error is more useful to the caller than the stream error
		{message: 'the real action failure'},
	);
});

test('oraPromise() - a failing persist write still returns the resolved value', async () => {
	const stream = getPassThroughStream();
	const originalWrite = stream.write;
	stream.write = function (content, ...rest) {
		// The stream fails while the success line is written
		if (String(content).includes('✔') || String(content).includes('√')) {
			throw new Error('stream EPIPE during persist');
		}

		return originalWrite.call(this, content, ...rest);
	};

	const result = await oraPromise(Promise.resolve('the-value'), {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		discardStdin: false,
	});

	assert.strictEqual(result, 'the-value');
});

test('oraPromise() - successText throwing does not render the failure symbol', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	let spinner;

	await assert.rejects(
		oraPromise(async currentSpinner => {
			spinner = currentSpinner;
			return 'done';
		}, {
			stream,
			text: 'foo',
			color: false,
			isEnabled: true,
			discardStdin: false,
			successText() {
				throw new Error('successText failed');
			},
		}),
		{message: 'successText failed'},
	);

	stream.end();

	assert.strictEqual(spinner.isSpinning, false);
	assert.doesNotMatch(toScreen(await output), /[×✖]/v);
});

test('oraPromise() - custom successSymbol', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const resolves = Promise.resolve(1);

	await oraPromise(resolves, {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		successSymbol: '🦄',
	});

	stream.end();

	assert.match(toScreen(await output), /🦄 foo\n$/v);
});

test('oraPromise() - custom successSymbol with successText', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const resolves = Promise.resolve(1);

	await oraPromise(resolves, {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		successSymbol: '🦄',
		successText: 'done',
	});

	stream.end();

	assert.match(toScreen(await output), /🦄 done\n$/v);
});

test('oraPromise() - custom failSymbol', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const rejects = Promise.reject(new Error()); // eslint-disable-line unicorn/error-message

	try {
		await oraPromise(rejects, {
			stream,
			text: 'foo',
			color: false,
			isEnabled: true,
			failSymbol: '💥',
		});
	} catch {}

	stream.end();

	assert.match(toScreen(await output), /💥 foo\n$/v);
});

test('oraPromise() - empty string successSymbol disables symbol', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const resolves = Promise.resolve(1);

	await oraPromise(resolves, {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		successSymbol: '',
	});

	stream.end();

	const result = toScreen(await output);
	assert.match(result, /foo\n$/v);
	assert.doesNotMatch(result, /[√✔] foo\n$/v);
});

test('a tab stops on the last cell when the terminal is as narrow as the tab stop', t => {
	// At eight columns a tab stops on the last cell, so counting it as reaching column eight would wrap one line too early
	const {stream, spinner} = createSpinner(t, {
		columns: 8,
		text: 'a\tb',
		spinner: {
			frames: ['-'],
		},
	});

	spinner.render();
	// The tab stops on the last cell, so the character after it is still on the first row
	t.assert.strictEqual(spinner._linesToClear, 1);
	t.assert.strictEqual(spinner._renderedFrame, '- a    b');

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), '\u{2714} done\n');
});

test('a wide character that does not fit the rest of the row starts the next one', t => {
	// Two wide characters fill four of five cells, so the third one wraps instead of being split
	const {spinner} = createSpinner(t, {
		columns: 5,
		text: '🦄'.repeat(5),
		spinner: {
			frames: [''],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 3);
});

test('an ansi escape sequence does not count towards the width of the frame', t => {
	// A styled string is as wide as the plain one, so it must not be measured, truncated, or cleared as wider
	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		rows: 10,
		text: `\u{1B}[31m${'x'.repeat(76)}\u{1B}[39m`,
		spinner: {
			frames: [''],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 1, 'the styled frame is one row like the plain one');

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), '\u{2714} done\n');
});

test('a colored frame is not truncated when the plain one fits', t => {
	// Nine plain lines fit on nine rows, but counting the color codes would overflow the width and truncate them
	const lines = Array.from({length: 9}, (_, index) => `\u{1B}[31mline ${index + 1} ${'x'.repeat(72)}\u{1B}[39m`);
	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		rows: 10,
		text: lines.join('\n'),
		spinner: {
			frames: [''],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 9, 'all nine lines are kept, the color takes no space');

	// The truncation message would make the frame ten rows, which cannot fit above the last row
	const lastRow = stream.toString().split('\n').at(-1);
	t.assert.ok(!lastRow.includes('truncated'), `the frame is not truncated, last row is ${JSON.stringify(lastRow)}`);
});

test('a truncated frame keeps the colors of the whole lines it keeps', t => {
	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		rows: 6,
		text: `\u{1B}[31mline 0\u{1B}[39m\n\u{1B}[31m${'x'.repeat(100)}\u{1B}[39m`,
	});

	const writes = [];
	const passthrough = stream.write.bind(stream);
	stream.write = (chunk, encoding, callback) => {
		writes.push(String(chunk));
		return passthrough(chunk, encoding, callback);
	};

	spinner.render();

	// The message takes two rows, so the long line is cut to the two rows that are left
	t.assert.strictEqual(stream.toString(), `${spinnerCharacter} line 0\n${'x'.repeat(20)}\n${'x'.repeat(20)}\n... (content truncat\ned to fit terminal)`);
	t.assert.strictEqual(spinner._linesToClear, 5);

	// The whole line keeps its colors, the part of the cut line is plain, and the style is reset before the message
	const frame = writes.find(write => write.includes('content truncat'));
	t.assert.strictEqual(frame, `${spinnerCharacter} \u{1B}[31mline 0\u{1B}[39m\n${'x'.repeat(20)}\n${'x'.repeat(20)}\n\u{1B}[0m... (content truncated to fit terminal)`);

	spinner.stop();
	t.assert.strictEqual(stream.toString(), '');
});

test('a tab in the text is measured as the cells it occupies', t => {
	// A tab advances to the next multiple of eight, so the frame wraps onto two rows that must both be erased
	const {stream, spinner} = createSpinner(t, {
		columns: 6,
		text: 'a\tbb',
		spinner: {
			frames: ['-'],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 2);

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), '\u{2714} done\n');
});

test('a tab that lands on the last cell of a full row does not make the frame taller', t => {
	// A tab on a full row takes no cell, so it must not make the frame taller
	const {spinner} = createSpinner(t, {
		columns: 20,
		rows: 10,
		text: `${'x'.repeat(20)}\t`,
		spinner: {
			frames: [''],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 1);
});

test('a keycap is measured as the two cells it takes', t => {
	// A keycap (digit, variation selector, enclosing mark) is one grapheme of two cells
	const {spinner} = createSpinner(t, {
		columns: 20,
		rows: 10,
		text: '1️⃣'.repeat(11),
		spinner: {
			frames: [''],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 2);
});

test('an emoji modifier after a letter is measured as part of the run it follows', t => {
	// A skin tone modifier after a letter shares its cell, so splitting the run would stretch the frame across four rows
	const {spinner} = createSpinner(t, {
		columns: 20,
		rows: 10,
		text: 'a\u{1F3FB}'.repeat(20),
		spinner: {
			frames: [''],
		},
	});

	spinner.render();
	t.assert.strictEqual(spinner._linesToClear, 1);
});

test('output written to a pipe keeps its line feeds as they are', async () => {
	// A terminal device adds the carriage return itself, so adding one here would only end up in logs and piped output
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: 'multi\nline',
		color: false,
		isEnabled: false,
	});

	spinner.start();
	spinner.succeed('first\nsecond');
	stream.end();

	assert.match(await output, /^- multi\nline\n[√✔] first\nsecond\n$/v);
});

test('a multi-line frame and result are written to a terminal with plain line feeds', () => {
	// The terminal device adds the carriage return itself
	const stream = getPassThroughStream();
	stream.isTTY = true;
	stream.columns = 20;

	const written = [];
	const originalWrite = stream.write;
	stream.write = function (content, ...rest) {
		written.push(String(content));
		return originalWrite.call(this, content, ...rest);
	};

	const spinner = ora({
		stream,
		text: 'a\nb',
		color: false,
		isEnabled: true,
		discardStdin: false,
	});

	spinner.render();
	spinner.succeed('c\nd');

	assert.ok(written.some(content => content.includes('a\nb')), 'the frame was written');
	assert.ok(written.some(content => content.includes('c\nd')), 'the result was written');
	assert.ok(!written.join('').includes('\r'), `no carriage return is written, got ${JSON.stringify(written)}`);
});

test('erases wrapped lines', () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	stream.columns = 40;
	let clearedLines = 0;
	let cursorAtRow = 0;
	stream.clearLine = () => {
		clearedLines++;
	};

	stream.moveCursor = (dx, dy) => {
		cursorAtRow += dy;
	};

	const reset = () => {
		clearedLines = 0;
		cursorAtRow = 0;
	};

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	spinner.render();
	assert.strictEqual(clearedLines, 0);
	assert.strictEqual(cursorAtRow, 0);

	spinner.text = 'foo\n\nbar';
	spinner.render();
	assert.strictEqual(clearedLines, 1); // Cleared 'foo'
	assert.strictEqual(cursorAtRow, 0);

	spinner.render();
	assert.strictEqual(clearedLines, 4); // Cleared 'foo\n\nbar'
	assert.strictEqual(cursorAtRow, -2);

	spinner.clear();
	reset();
	spinner.text = '0'.repeat(stream.columns + 10);
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines, 2);
	assert.strictEqual(cursorAtRow, -1);

	spinner.clear();
	reset();
	// Unicorns take up two cells, so this creates 3 rows of text not two
	spinner.text = '🦄'.repeat(stream.columns + 10);
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines, 3);
	assert.strictEqual(cursorAtRow, -2);

	spinner.clear();
	reset();
	// Unicorns take up two cells. Remove the spinner and space and fill two rows,
	// then force a linebreak and write the third row.
	spinner.text = '🦄'.repeat(stream.columns - 2) + '\nfoo';
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines, 3);
	assert.strictEqual(cursorAtRow, -2);

	spinner.clear();
	reset();
	spinner.prefixText = 'foo\n';
	spinner.text = '\nbar';
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines, 3); // Cleared 'foo\n\nbar'
	assert.strictEqual(cursorAtRow, -2);

	spinner.clear();
	reset();
	spinner.prefixText = 'foo\n';
	spinner.text = '\nbar';
	spinner.suffixText = '\nbaz';
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines, 4); // Cleared 'foo\n\nbar \nbaz'
	assert.strictEqual(cursorAtRow, -3);

	spinner.stop();
});

test('reset frameIndex when setting new spinner', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		isEnabled: true,
		spinner: {
			frames: [
				'foo',
				'fooo',
			],
		},
	});

	assert.strictEqual(spinner._frameIndex, -1);

	spinner.render();
	assert.strictEqual(spinner._frameIndex, 0);

	spinner.spinner = {frames: ['baz']};
	spinner.render();

	stream.end();

	assert.strictEqual(spinner._frameIndex, 0);
	assert.match(toScreen(await output), /foo baz/v);
});

test('ignore consecutive calls to `.start()` when output was disabled while spinning', async t => {
	const {stream, spinner} = createSpinner(t, {stream: getPassThroughStream(), text: 'foo'});
	const output = getStream(stream);

	spinner.start();
	spinner.isEnabled = false;
	spinner.start('bar');
	spinner.stop();
	stream.end();

	t.assert.strictEqual(spinner.text, 'bar');
	t.assert.doesNotMatch(toScreen(await output), /bar/v);
});

test('with output disabled, every call to `.start()` logs a line', async () => {
	const result = await doRawSpinner(spinner => {
		spinner.start('bar');
	}, {isEnabled: false});

	assert.strictEqual(result, '- foo\n- bar\n');
});

test('changing the spinner while spinning shows the new spinner right away', t => {
	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		spinner: {
			frames: ['a'],
			// Long enough that only an immediate render can show the new spinner
			interval: 100_000,
		},
	});

	spinner.start();
	t.assert.strictEqual(stream.toString(), 'a foo');

	spinner.spinner = {frames: ['b'], interval: 100_000};
	t.assert.strictEqual(stream.toString(), 'b foo');
});

test('a rejected spinner leaves the current spinner and interval alone', () => {
	const stream = getPassThroughStream();
	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		interval: 500,
		spinner: {
			frames: ['a', 'b'],
		},
	});

	spinner.render();
	assert.strictEqual(spinner._frameIndex, 0);

	assert.throws(() => {
		spinner.spinner = {frames: []};
	}, {message: 'The given spinner must have a non-empty `frames` array of strings'});

	assert.strictEqual(spinner._frameIndex, 0, 'the frame index should not be reset');
	assert.deepStrictEqual(spinner.spinner, {frames: ['a', 'b']});
	assert.strictEqual(spinner.interval, 500);

	spinner.stop();
});

test('changing the spinner while spinning applies the new interval', t => {
	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		spinner: {
			frames: ['a'],
			interval: 1000,
		},
	});

	let writes = 0;
	const originalWrite = stream.write;
	stream.write = function (...arguments_) {
		writes++;
		return originalWrite.apply(this, arguments_);
	};

	// The mocked `Date` advances with `tick()`, which lets the frame throttle in `frame()` release the next frame
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	spinner.start();
	spinner.spinner = {frames: ['a', 'b'], interval: 10};

	writes = 0;

	// The old interval is 1000, so a single tick is enough to tell the two apart
	t.mock.timers.tick(10);

	t.assert.ok(writes > 0, `expected the new interval to be used, got ${writes} renders in 10ms`);
	t.assert.strictEqual(spinner.interval, 10);
});

test('set the correct interval when changing spinner (object case)', () => {
	const spinner = ora({
		isEnabled: false,
		spinner: {frames: ['foo', 'bar']},
		interval: 300,
	});

	assert.strictEqual(spinner.interval, 300);

	spinner.spinner = {frames: ['baz'], interval: 200};

	assert.strictEqual(spinner.interval, 200);
});

test('set the correct interval when changing spinner (string case)', () => {
	const spinner = ora({
		isEnabled: false,
		spinner: 'dots',
		interval: 100,
	});

	assert.strictEqual(spinner.interval, 100);

	spinner.spinner = 'layer';

	const expectedInterval = process.platform === 'win32' ? 130 : 150;
	assert.strictEqual(spinner.interval, expectedInterval);
});

// The name is rejected before anything is rendered, so this holds on every platform
test('throw when incorrect spinner', () => {
	const spinner = ora();

	assert.throws(() => {
		spinner.spinner = 'random-string-12345';
	}, {
		message: /no built-in spinner/v,
	});
});

test('throw when spinner is set to `default`', () => {
	assert.throws(() => {
		ora({spinner: 'default'});
	}, {
		message: /no built-in spinner/v,
	});
});

test('throw a descriptive error when spinner is set to null', () => {
	// `typeof null === 'object'`, so it must not reach the object validation
	assert.throws(() => {
		ora({spinner: null});
	}, {
		message: /no built-in spinner/v,
	});

	const spinner = ora({isEnabled: false});
	assert.throws(() => {
		// @ts-expect-error Intentional invalid value
		spinner.spinner = null;
	}, {
		message: /no built-in spinner/v,
	});
});

test('throw when an unknown spinner is used on a terminal without Unicode', t => {
	// The Linux console is the one terminal outside Windows without Unicode, and Windows is detected by other variables
	if (process.platform === 'win32') {
		return;
	}

	withLinuxConsole(() => {
		t.assert.throws(() => {
			ora({spinner: 'random-string-12345'});
		}, {
			message: /no built-in spinner/v,
		});

		t.assert.throws(() => {
			ora({spinner: null});
		}, {
			message: /no built-in spinner/v,
		});

		// A known name still falls back to a spinner the terminal can show
		t.assert.strictEqual(ora({spinner: 'dots'}).spinner, spinners.line);
	});
});

test('indent option', () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	let cursorAtRow = 0;
	stream.cursorTo = indent => {
		cursorAtRow = indent;
	};

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		indent: 7,
	});

	assert.strictEqual(spinner.frame(), `       ${spinnerCharacter} foo`);

	spinner.render();
	spinner.clear();
	assert.strictEqual(cursorAtRow, 0, 'clearing leaves the cursor at the start of the line');
	spinner.stop();
});

test('indent option - persisted line is indented when the spinner is disabled', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		indent: 4,
		isEnabled: false,
	});

	spinner.start();
	spinner.succeed('done');
	stream.end();

	assert.match(toScreen(await output), /^ {4}- foo\n {4}[√✔] done\n$/v);
});

test('indent option - persisted line is not indented twice when the cursor is positioned', t => {
	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		indent: 2,
	});

	spinner.start();
	t.assert.strictEqual(stream.toString(), `  ${spinnerCharacter} foo`);

	spinner.succeed('done');
	t.assert.match(stream.toString(), /^ {2}[√✔] done\n?$/v);
});

test('stream option - falls back to process.stderr when undefined', t => {
	const originalStderrWrite = process.stderr.write;
	const writes = [];
	// Swallow the output so it does not end up in the test results
	process.stderr.write = function (content) {
		writes.push(stripVTControlCharacters(content.toString()));
		return true;
	};

	t.after(() => {
		process.stderr.write = originalStderrWrite;
	});

	// Spreading options over a default object can set `stream` to `undefined`
	const spinner = ora({
		text: 'foo',
		stream: undefined,
		color: false,
		isEnabled: true,
		discardStdin: false,
	});

	spinner.start();
	spinner.succeed('done');

	t.assert.match(writes.join(''), /[√✔] done\r?\n$/v);
});

test('indent option throws', () => {
	const stream = getPassThroughStream();

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	assert.throws(() => {
		spinner.indent = -1;
	}, {
		message: 'The `indent` option must be an integer from 0 and up',
	});
});

test('handles wrapped lines when length of indent + text is greater than columns', () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	stream.columns = 20;

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	spinner.render();

	spinner.text = '0'.repeat(spinner._stream.columns - 5);
	spinner.indent = 15;
	spinner.render();

	assert.strictEqual(spinner._lineCount, 2);
});

test('.stopAndPersist() with prefixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'foo'});
	}, {prefixText: 'bar'});
	assert.match(result, /bar @ foo\n$/v);
});

test('.stopAndPersist() with empty prefixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'foo'});
	}, {prefixText: ''});
	assert.match(result, /@ foo\n$/v);
});

test('.stopAndPersist() with manual prefixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', prefixText: 'baz', text: 'foo'});
	}, {prefixText: 'bar'});
	assert.match(result, /baz @ foo\n$/v);
});

test('.stopAndPersist() with manual empty prefixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', prefixText: '', text: 'foo'});
	}, {prefixText: 'bar'});
	assert.match(result, /@ foo\n$/v);
});

test('.stopAndPersist() with dynamic prefixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '&', prefixText: () => 'babeee', text: 'yorkie'});
	}, {prefixText: () => 'babeee'});
	assert.match(result, /babeee & yorkie\n$/v);
});

test('.stopAndPersist() with suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'foo'});
	}, {suffixText: 'bar'});
	assert.match(result, /@ foo bar\n$/v);
});

test('.stopAndPersist() with empty suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'foo'});
	}, {suffixText: ''});
	assert.match(result, /@ foo\n$/v);
});

test('.stopAndPersist() with manual suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', suffixText: 'baz', text: 'foo'});
	}, {suffixText: 'bar'});
	assert.match(result, /@ foo baz\n$/v);
});

test('.stopAndPersist() with manual empty suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', suffixText: '', text: 'foo'});
	}, {suffixText: 'bar'});
	assert.match(result, /@ foo\n$/v);
});

test('.stopAndPersist() with dynamic suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '&', suffixText: () => 'babeee', text: 'yorkie'});
	}, {suffixText: () => 'babeee'});
	assert.match(result, /& yorkie babeee\n$/v);
});

test('.stopAndPersist() with prefixText and suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: 'foo'});
	}, {prefixText: 'bar', suffixText: 'baz'});
	assert.match(result, /bar @ foo baz\n$/v);
});

test('.stopAndPersist() with dynamic prefixText and suffixText', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '#', text: 'work'});
	}, {prefixText: () => 'pre', suffixText: () => 'post'});
	assert.match(result, /pre # work post\n$/v);
});

test('.stopAndPersist() with dynamic empty prefixText and suffixText has no stray spaces', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '#', text: 'work'});
	}, {prefixText: () => '', suffixText: () => ''});
	assert.match(result, /# work\n$/v);
});

test('.stopAndPersist() with a symbol and empty text has no doubled space', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: ''});
	}, {prefixText: 'pre', suffixText: 'post'});

	// The suffix must not add a second separator after the empty text
	assert.match(result, /pre @ post\n$/v);
});

test('.stopAndPersist() with a symbol and empty text keeps one space before the suffix', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '@', text: ''});
	}, {suffixText: 'post'});

	assert.match(result, /@ post\n$/v);
});

test('.stopAndPersist() with a symbol and non-string text keeps one space before the suffix', async () => {
	const result = await doSpinner(spinner => {
		// @ts-expect-error Intentional invalid text
		spinner.stopAndPersist({symbol: '@', text: 42});
	}, {suffixText: 'post'});

	assert.match(result, /@ post\n$/v);
});

test('.stopAndPersist() with empty symbol does not add separator', async () => {
	const result = await doSpinner(spinner => {
		spinner.stopAndPersist({symbol: '', text: 'done'});
	}, {});
	assert.match(result, /done\n$/v);
});

// Additional focused edge-case tests

test('throws when spinner object has invalid `frames`', () => {
	const spinner = ora({isEnabled: false});

	assert.throws(() => {
		// @ts-expect-error Intentional invalid object
		spinner.spinner = {};
	}, {
		message: 'The given spinner must have a non-empty `frames` array of strings',
	});
});

test('interval defaults to 100 when custom spinner has no interval', () => {
	const spinner = ora({isEnabled: false});
	spinner.spinner = {frames: ['-']};
	assert.strictEqual(spinner.interval, 100);
});

test('isEnabled setter enforces boolean', () => {
	const spinner = ora({isEnabled: false});

	assert.throws(() => {
		// @ts-expect-error Intentional invalid assignment
		spinner.isEnabled = 'yes';
	}, {
		message: 'The `isEnabled` option must be a boolean',
	});
});

test('isSilent setter enforces boolean', () => {
	const spinner = ora();

	assert.throws(() => {
		// @ts-expect-error Intentional invalid assignment
		spinner.isSilent = 'no';
	}, {
		message: 'The `isSilent` option must be a boolean',
	});
});

test('oraPromise(function) passes spinner and supports successText function', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const action = async sp => {
		sp.text = 'working';
		return 7;
	};

	await oraPromise(action, {
		stream,
		color: false,
		isEnabled: false, // Avoid timers; still prints persisted line
		successText: result => `done: ${result}`,
	});

	stream.end();
	assert.match(toScreen(await output), /[√✔] done: 7\n$/v);
});

test('oraPromise(function) rejects and supports failText function', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const boom = new Error('boom');

	try {
		await oraPromise(async () => {
			throw boom;
		}, {
			stream,
			color: false,
			isEnabled: false, // Avoid timers; still prints persisted line
			failText: error => `oops: ${error.message}`,
		});
	} catch {}

	stream.end();
	assert.match(toScreen(await output), /[×✖] oops: boom\n$/v);
});

test('oraPromise() validates `action` type', async () => {
	await assert.rejects(async () => {
		// @ts-expect-error Intentional invalid input
		await oraPromise(123, {isEnabled: false});
	}, {
		message: 'Parameter `action` must be a Function or a Promise',
	});
});

test('oraPromise() throws the validation error for nullish `action`', async () => {
	await Promise.all([null, undefined].map(action => assert.rejects(async () => {
		// @ts-expect-error Intentional invalid input
		await oraPromise(action, {isEnabled: false});
	}, {
		message: 'Parameter `action` must be a Function or a Promise',
	})));
});

test('oraPromise() tolerates `null` options', async () => {
	// @ts-expect-error Intentional invalid input
	const result = await oraPromise(Promise.resolve('🦄'), null);
	assert.equal(result, '🦄');
});

test('clear() is a no-op when stream is not TTY', () => {
	const stream = getPassThroughStream();
	let cleared = 0;
	let moved = 0;
	stream.clearLine = () => {
		cleared++;
	};

	stream.moveCursor = () => {
		moved++;
	};

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	spinner.render();
	const before = spinner._linesToClear;
	spinner.clear();

	// Nothing should have happened
	assert.strictEqual(spinner._linesToClear, before);
	assert.strictEqual(cleared, 0);
	assert.strictEqual(moved, 0);

	spinner.stop();
});

// Some CI log streams report themselves as a TTY but have no readline cursor methods
const getTtyStreamWithoutCursorMethods = () => {
	const stream = new PassThroughStream();
	stream.isTTY = true;
	stream.columns = 80;
	stream.rows = 25;
	return stream;
};

test('render() works on a TTY stream without the cursor methods', async t => {
	const {stream, spinner} = createSpinner(t, {stream: getTtyStreamWithoutCursorMethods(), text: 'foo'});
	const output = getStream(stream);

	spinner.start();
	spinner.render();
	spinner.succeed('done');
	// Without cursor methods nothing can be erased
	spinner.clear();

	stream.end();
	// Both frames stay, because nothing could take the first one back
	t.assert.match(toScreen(await output), new RegExp(String.raw`^${spinnerCharacter} foo${spinnerCharacter} foo[√✔] done\n$`, 'v'));
});

test('succeed() works on a TTY stream without the cursor methods when a partial line is pending', async t => {
	const {stream, spinner} = createSpinner(t, {stream: getTtyStreamWithoutCursorMethods(), text: 'foo'});
	const output = getStream(stream);

	spinner.start();

	// Taking back the partial line needs cursor control, which this stream lacks
	stream.write('Progress: 50%');

	spinner.succeed('done');

	stream.end();
	// The partial line stays, and the result starts on the next line
	t.assert.match(toScreen(await output), new RegExp(String.raw`^${spinnerCharacter} fooProgress: 50%\n[√✔] done\n$`, 'v'));
});

test('clear() is a no-op on a TTY stream without the cursor methods', t => {
	const {spinner} = createSpinner(t, {stream: getTtyStreamWithoutCursorMethods(), text: 'foo'});

	spinner.render();
	const before = spinner._linesToClear;
	t.assert.strictEqual(before, 1, 'the frame is one line long');

	spinner.clear();

	// The frame stays, so there is nothing to erase
	t.assert.strictEqual(spinner._linesToClear, before);
});

test('a frame that starts below the top of the screen can scroll it away', t => {
	/*
	Ora cannot read the cursor row synchronously, so it only keeps the frame above the last row of the screen. A tall frame that starts lower down still scrolls earlier output.
	*/
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		rows: 6,
		columns: 20,
		text: 'a longer piece of loading text that will wrap on a narrow terminal',
	});

	// Only three rows are left below the cursor
	stream.write('pre0\npre1\npre2\n');
	spinner.start();

	// Without the cursor row, the screen height is the best bound
	t.assert.ok(spinner._linesToClear <= 5, `the frame is bounded by the screen height, got ${spinner._linesToClear} rows`);
});

test('a wrapped line is not emitted twice when the frame is truncated', t => {
	// Each row of a wrapped line must be emitted once, or the extra row scrolls the frame and drops content that would fit
	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		rows: 8,
		text: `Downloading ${'x'.repeat(70)}\n${Array.from({length: 8}, (_, index) => `detail line ${index}`).join('\n')}`,
		spinner: {
			frames: ['⠋'],
		},
	});

	spinner.start();

	// The frame stays above the last row
	t.assert.ok(spinner._linesToClear <= 7, `the frame must stay within rows - 1, got ${spinner._linesToClear}`);

	// The long line appears once
	const occurrences = stream.toString().split('Downloading').length - 1;
	t.assert.strictEqual(occurrences, 1, `the wrapped line must appear once, got ${occurrences}`);
});

test('a single line that wraps past the console height is truncated', t => {
	const {stream, spinner} = createSpinner(t, {
		rows: 5,
		columns: 40,
		// One long line that wraps into 16 lines at 40 columns
		text: 'x'.repeat(600),
	});

	spinner.start();

	// Three content lines plus the truncation message, leaving the last row free
	const lines = stream.toString().split('\n');
	t.assert.strictEqual(lines.length, 4);
	t.assert.ok(stream.toString().includes('(content truncated to fit terminal)'));

	spinner.stop();
	t.assert.strictEqual(stream.toString(), '');
});

test('truncated content never fills the last terminal row, so the frame does not scroll off screen', t => {
	// With three rows only two lines are written, so the cursor stays above the last row and the terminal does not scroll
	const {stream, spinner} = createSpinner(t, {
		rows: 3,
		columns: 80,
		text: 'a\nb\nc\nd\ne',
	});

	stream.write('PRIOR\n');
	spinner.start();
	t.assert.ok(stream.toString().includes('(content truncated to fit terminal)'));

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), 'PRIOR\n✔ done\n');
});

test('the truncation message cannot wrap the frame past the last terminal row', t => {
	// The message wraps onto several lines on a narrow terminal, and the frame must still fit
	const {stream, spinner} = createSpinner(t, {
		rows: 5,
		columns: 10,
		text: Array.from({length: 8}, (_, index) => String.fromCodePoint(97 + index)).join('\n'),
	});

	stream.write('PRIOR\n');
	spinner.start();
	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), 'PRIOR\n✔ done\n');
});

test('the truncation message is shortened until it fits the row budget', t => {
	// Only one row is available, so the message is cut to two cells
	const {spinner} = createSpinner(t, {
		columns: 2,
		rows: 2,
		text: Array.from({length: 8}, (_, index) => `line ${index}`).join('\n'),
		spinner: {
			frames: [''],
		},
	});

	spinner.start();

	t.assert.strictEqual(spinner._renderedFrame, '..');
	t.assert.strictEqual(spinner._linesToClear, 1);
});

test('a wider terminal keeps more of the truncation message', t => {
	const {spinner} = createSpinner(t, {
		columns: 4,
		rows: 4,
		text: Array.from({length: 8}, (_, index) => `line ${index}`).join('\n'),
		spinner: {
			frames: [''],
		},
	});

	spinner.start();

	// Four columns keep more of the message, within the budget
	t.assert.ok(spinner._renderedFrame.length > 1, `the message should be longer than one cell, got ${JSON.stringify(spinner._renderedFrame)}`);
	t.assert.ok(spinner._linesToClear <= 3, `the frame must stay within 3 rows, got ${spinner._linesToClear}`);
});

test('a frame never exceeds the row budget on a very narrow terminal', t => {
	// The marker is shortened until the frame stays above the last row
	for (const [columns, rows] of [[1, 2], [2, 2], [1, 3]]) {
		const {spinner} = createSpinner(t, {
			columns,
			rows,
			text: Array.from({length: 8}, (_, index) => `line ${index}`).join('\n'),
		});

		spinner.start();

		t.assert.ok(
			spinner._linesToClear <= rows - 1,
			`at ${columns}x${rows} the frame must stay within ${rows - 1} rows, got ${spinner._linesToClear}`,
		);

		spinner.stop();
	}
});

test('a narrow terminal always shows something, never an empty frame', t => {
	// The truncation message does not fit a very narrow terminal, so a short marker is used instead of an empty frame
	const {stream, spinner} = createSpinner(t, {
		rows: 4,
		columns: 4,
		text: '🦄'.repeat(20),
	});

	spinner.start();

	t.assert.ok(spinner._linesToClear > 0, 'a frame is written');
	t.assert.ok(spinner._linesToClear <= 3, `the frame stays above the last row, got ${spinner._linesToClear}`);

	spinner.stop();
	t.assert.strictEqual(stream.toString(), '');
});

test('a truncation message taller than the terminal drops the content, not the message', t => {
	// The message leaves no room for content, and a negative slice end would keep almost every line and scroll the screen
	const {stream, spinner} = createSpinner(t, {
		rows: 4,
		columns: 12,
		text: Array.from({length: 8}, (_, index) => String.fromCodePoint(97 + index)).join('\n'),
	});

	stream.write('PRIOR\n');
	spinner.start();

	// A short marker replaces the message, and the frame stays above the last row
	t.assert.strictEqual(spinner._linesToClear, 3, 'the frame stays within rows - 1');

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), 'PRIOR\n✔ done\n');
});

test('a frame that exactly fills the terminal scrolls, so it is truncated instead', t => {
	// Writing `rows` lines moves the cursor past the last row and scrolls the frame away
	const {stream, spinner} = createSpinner(t, {
		rows: 3,
		columns: 80,
		text: 'a\nb\nc',
	});

	stream.write('PRIOR\n');
	spinner.start();
	t.assert.strictEqual(stream.toString(), `PRIOR\n${spinnerCharacter} a\n... (content truncated to fit terminal)`, 'the frame is truncated before it can scroll');

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), 'PRIOR\n✔ done\n');
});

test('a frame that fits in the terminal without scrolling is left alone', t => {
	// Two rows leave the cursor on the last row, so the frame stays on screen
	const {stream, spinner} = createSpinner(t, {
		rows: 3,
		columns: 80,
		text: 'a\nb',
	});

	stream.write('PRIOR\n');
	spinner.start();
	t.assert.strictEqual(stream.toString(), `PRIOR\n${spinnerCharacter} a\nb`);

	spinner.succeed('done');
	t.assert.strictEqual(stream.toString(), 'PRIOR\n✔ done\n');
});

test('stream with zero columns falls back to 80 columns', () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	// A terminal can report 0 columns, for example while the window is minimized
	stream.columns = 0;

	let clearedLines = 0;
	stream.clearLine = () => {
		clearedLines++;
	};

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		discardStdin: false,
	});

	spinner.render();
	assert.strictEqual(clearedLines, 0);

	// Without a fallback every character takes its own row, so this would erase far more than the frame
	spinner.render();
	assert.strictEqual(clearedLines, 1);

	spinner.stop();
});

test('a tab is expanded the same way everywhere in the frame', t => {
	// The drawn frame, the stored frame, and the row count must expand tabs the same way
	const cases = [
		// A tab after a newline starts from column zero again
		['a\n\tb', 'a\n        b', 2],
		// A carriage return resets the column, so the tab covers eight cells again
		['ab\r\tc', 'ab\r        c', 1],
		['a\t\r\tx', 'a       \r        x', 1],
		['\ta', '        a', 1],
		['a\tb', 'a       b', 1],
		['a\t\tb', 'a               b', 1],
	];

	for (const [text, expanded, lines] of cases) {
		const {spinner} = createSpinner(t, {
			columns: 20,
			rows: 10,
			text,
			spinner: {
				frames: [''],
			},
		});

		spinner.start();

		t.assert.strictEqual(spinner._renderedFrame, expanded, `the frame for ${JSON.stringify(text)}`);
		t.assert.strictEqual(spinner._linesToClear, lines, `the row count for ${JSON.stringify(text)}`);

		spinner.stop();
	}
});

test('a tab after a wrap is measured from the row it lands on', t => {
	// A tab after a wrap is measured from the visual row, or the stored frame is a row short and is not erased after a resize
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 19,
		rows: 12,
		// Fourteen characters, then a tab that wraps, then more text and another tab
		text: '111abcdefghij\tabcdefghij\t1',
		interval: 100_000,
		spinner: {
			frames: ['#'],
		},
	});

	stream.write('PRIOR\n');
	spinner.start();

	// Fourteen cells, a tab to column sixteen, and ten more make twenty-seven cells, which is two rows at nineteen columns
	t.assert.strictEqual(spinner._linesToClear, 2);

	// Widening reflows those cells, so the stored frame must hold them
	stream.columns = 40;
	spinner.succeed('done');

	t.assert.strictEqual(stream.toString(), 'PRIOR\n\u{2714} done\n');
});

test('the stored frame holds the tabs as the cells a terminal shows', t => {
	// A terminal re-wraps the expanded cells on resize, so the stored frame must hold the expansion
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {spinner} = createSpinner(t, {
		columns: 40,
		rows: 10,
		text: 'aaaaaaaa\taaaaaaaa',
		interval: 100_000,
	});

	spinner.start();

	// The symbol and eight a's are ten cells, so the tab fills six cells up to the tab stop at sixteen
	t.assert.strictEqual(spinner._renderedFrame, `${spinnerCharacter} aaaaaaaa      aaaaaaaa`);
	t.assert.ok(!spinner._renderedFrame.includes('\t'), 'the frame holds the expansion, not a tab');
	t.assert.strictEqual(spinner._renderedColumns, 40);
});

test('narrowing the terminal does not increase the erase count for a frame with a tab', t => {
	// The expanded frame may take more rows at the new width, but the terminal may keep its cursor line on one row
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 10,
		text: 'aaaaaaaa\taaaaaaaa',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();
	const clearLine = t.mock.method(stream, 'clearLine');

	stream.columns = 10;
	spinner.succeed('done');

	// The test terminal replays writes instead of resizing cells, so leftover frame content is best effort
	t.assert.strictEqual(clearLine.mock.callCount(), 1);
	t.assert.ok(stream.toString().startsWith('PRIOR\n'));
});

test('a frame with a carriage return is erased after the terminal is resized', t => {
	// A frame with a carriage return is laid out differently once a resize reflows its rows
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 6,
		rows: 12,
		text: 'xxxxx\rshort',
		interval: 100_000,
		spinner: {
			frames: ['⠋'],
		},
	});

	spinner.start();
	t.assert.strictEqual(spinner._linesToClear, 2);

	/*
	A terminal reflows the cells it has instead of replaying the text, so the row reached after the carriage return still counts. This holds for the resize path, which re-measures the stored frame.
	*/
	stream.columns = 8;
	spinner.succeed('done');

	t.assert.ok(!stream.toString().includes('xxxx'), 'the whole frame is erased');
});

test('a multi-line frame is erased after the terminal is resized in either direction', t => {
	// Widening and narrowing must both leave the line above the spinner alone
	for (const [from, to] of [[80, 40], [80, 20], [40, 80], [20, 40]]) {
		const {stream, spinner} = createSpinner(t, {
			columns: from,
			rows: 12,
			text: Array.from({length: 3}, (_, index) => `line ${index}`).join('\n'),
			spinner: {
				frames: ['-'],
			},
		});

		stream.write('PRIOR\n');
		spinner.start();
		stream.columns = to;
		spinner.succeed('done');

		t.assert.strictEqual(stream.toString(), 'PRIOR\n\u{2714} done\n', `resized ${from} to ${to}`);

		spinner.stop();
	}
});

test('a frame whose text has a carriage return and a line feed is erased after a resize', t => {
	// The segmenter treats `\r\n` as one grapheme, so the pair must be split before segmenting or the row after it is not counted
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		rows: 12,
		text: 'first\r\nsecond',
		interval: 100_000,
		spinner: {
			frames: ['⠋'],
		},
	});

	spinner.start();
	t.assert.strictEqual(spinner._linesToClear, 2);

	// The frame is two rows at this width too, so both must be erased
	stream.columns = 40;
	spinner.succeed('done');

	t.assert.strictEqual(stream.toString(), '✔ done\n');
});

test('narrowing the terminal does not increase the erase count for a frame that overwrites its own cells', t => {
	// A carriage return does not erase the row, so the row is as wide as the widest pass over it
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		rows: 12,
		text: `${'x'.repeat(30)}\r${'y'.repeat(30)}`,
		interval: 100_000,
		spinner: {
			frames: ['⠋'],
		},
	});

	stream.write('PRIOR\n');
	spinner.start();
	t.assert.strictEqual(spinner._linesToClear, 1);
	const clearLine = t.mock.method(stream, 'clearLine');

	// Thirty cells take two rows at twenty columns, so the frame and the line above it cover three rows
	stream.columns = 20;
	t.assert.strictEqual(stream.toString().split('\n').length, 4);

	/*
	The erase count must stay bounded by the recorded frame, even when the test terminal replays it onto more rows. Leftover frame content is best effort.
	*/
	spinner.stop();
	t.assert.strictEqual(clearLine.mock.callCount(), 1);
	t.assert.ok(stream.toString().startsWith('PRIOR\n'));
});

test('a tab after a carriage return and a line feed expands from the start of the row', t => {
	// The segmenter treats `\r\n` as one grapheme, so it must be split to know the column
	const {spinner} = createSpinner(t, {
		columns: 80,
		rows: 12,
		text: 'a\r\n\tb',
		spinner: {
			frames: ['⠋'],
		},
	});

	spinner.start();

	// The row starts at column zero, so the tab reaches the first tab stop
	t.assert.strictEqual(spinner._renderedFrame, '⠋ a\r\n        b');
});

test('a tab on a row that a frame has just filled is measured the same way everywhere', t => {
	// A tab on a full row covers no cell, so expanding it would make the stored frame a row too tall
	const {spinner} = createSpinner(t, {
		columns: 8,
		rows: 12,
		text: 'aaaaaaaa\t',
		spinner: {
			// An empty frame leaves the whole row to the text
			frames: [''],
		},
	});

	spinner.start();

	// Eight cells fill the row, and the tab covers none
	t.assert.strictEqual(spinner._linesToClear, 1);
	t.assert.strictEqual(spinner._renderedFrame, 'aaaaaaaa');
});

test('a tab in a styled frame is expanded from the column the terminal measures', t => {
	// Escape sequences take no cells, so the tab column must be measured without them
	const {spinner} = createSpinner(t, {
		columns: 80,
		rows: 12,
		text: `${String.fromCodePoint(27)}[1mab${String.fromCodePoint(27)}[22m\tc`,
		spinner: {
			frames: ['⠋'],
		},
	});

	spinner.start();

	// The four visible cells before the tab take it to the first tab stop
	t.assert.strictEqual(spinner._renderedFrame, '⠋ ab    c');
});

test('a spinner that stops itself still erases the frame that was already on screen', t => {
	// When a render fails, the previous frame is still on screen, so stopping must erase it
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		text: 'working',
		interval: 10,
	});

	const passthrough = stream.write.bind(stream);
	let isFailing = false;
	stream.write = (chunk, encoding, callback) => {
		if (isFailing && String(chunk) === synchronizedOutputEnable) {
			throw new Error('EPIPE: stream broken');
		}

		return passthrough(chunk, encoding, callback);
	};

	spinner.start();
	isFailing = true;

	t.mock.timers.tick(10);
	t.assert.strictEqual(spinner.isSpinning, false, 'the spinner stopped itself');

	spinner.stop();
	t.assert.strictEqual(stream.toString(), '', 'the frame is erased');
});

test('a spinner that runs again hooks the stream a second time', t => {
	// A restarted spinner must hook the same stream again, so an external write does not land in its frame
	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		spinner: {
			frames: ['-'],
		},
	});

	spinner.start();
	spinner.stop();
	spinner.start();

	// The write erases the frame first, so the line above the spinner stays
	stream.write('LOG\n');
	spinner.succeed('done');

	t.assert.strictEqual(stream.toString(), 'LOG\n✔ done\n');
});

test('an unfinished line is not duplicated by a later spinner run', t => {
	// Stopping and restarting must not duplicate the program's output
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();
	stream.write('Downloading 42');

	// Persisting ends the run before the rest of the line arrives
	t.mock.timers.tick(200);
	spinner.succeed('done');

	spinner.start('again');
	// The next run must not repeat the earlier output
	stream.write('!\n');

	t.assert.strictEqual(stream.toString(), `Downloading 42\n✔ done\n!\n${spinnerCharacter} again`);
});

test('a spinner that stops itself from a timer render gives the cursor back', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {interval: 10});

	const writes = [];
	const passthrough = stream.write.bind(stream);
	stream.write = (chunk, encoding, callback) => {
		writes.push(String(chunk));
		return passthrough(chunk, encoding, callback);
	};

	spinner.start();
	writes.length = 0;

	// The spinner stops itself when the affix throws
	spinner.prefixText = () => {
		throw new Error('boom');
	};

	t.mock.timers.tick(10);

	t.assert.strictEqual(spinner.isSpinning, false);
	t.assert.ok(writes.includes('\u{1B}[?25h'), 'the cursor is shown again');
});

test('a spinner that stops itself from a timer render stops discarding stdin', t => {
	// `stdinDiscarder` counts starts, so a run that stops itself must release its count or stdin stays in raw mode
	withFakeStdin({}, ({fakeStdin, rawModeCalls}) => {
		t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

		const spinner = ora({
			stream: new LocalTransformTTY(),
			color: false,
			isEnabled: true,
			interval: 10,
		});

		try {
			spinner.start();
			spinner.prefixText = () => {
				throw new Error('boom');
			};

			t.mock.timers.tick(10);

			t.assert.strictEqual(spinner.isSpinning, false);
			spinner.prefixText = '';

			spinner.start('again');
			spinner.stop();

			t.assert.strictEqual(fakeStdin.isRaw, false, 'stdin is out of raw mode');
			// Two runs, each one taking raw mode and giving it back
			t.assert.deepStrictEqual(rawModeCalls, [true, false, true, false]);
		} finally {
			spinner.stop();
		}
	});
});

test('a stop that cannot erase the frame still finishes the teardown', t => {
	/*
	The erase is the part most likely to fail, since this stream's cursor methods write to it. The rest of the teardown must still happen, or the terminal is left without a cursor.
	*/
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 10,
		text: 'working',
		interval: 100_000,
	});

	const writes = [];
	let isFailing = false;
	const passthrough = stream.write.bind(stream);
	stream.write = (chunk, encoding, callback) => {
		if (isFailing) {
			throw new Error('EPIPE: stream broken');
		}

		writes.push(String(chunk));
		return passthrough(chunk, encoding, callback);
	};

	spinner.start();
	isFailing = true;

	// Neither the erase nor the cursor leaves anything to undo, so the teardown does not throw for them
	spinner.stop();
	t.assert.strictEqual(spinner.isSpinning, false);

	// The frame was forgotten, so a later stop has nothing left to write
	isFailing = false;
	writes.length = 0;
	spinner.stop();

	t.assert.deepStrictEqual(writes, []);
});

test('resizing a frame preserves preceding output for any text', t => {
	/*
	A frame that wraps, overwrites its own cells, or has a carriage return must leave preceding output alone. Narrowing may leave part of the frame visible. The text is seeded, so a failure names the input that broke.
	*/
	const random = seededRandom(0xC0_FF_EE);
	// The test terminal counts every code point as one cell, so tabs and wide graphemes are left to the tests above
	const alphabet = [...'abc hij', '\n', '\r', '\r\n', '  '];
	const widths = [2, 3, 5, 8, 13, 20, 40, 80];

	for (const from of widths) {
		for (const to of widths) {
			for (let attempt = 0; attempt < 10; attempt++) {
				const text = Array.from(
					{length: 1 + Math.floor(random() * 24)},
					() => alphabet[Math.floor(random() * alphabet.length)],
				).join('');

				const {stream, spinner} = createSpinner(t, {
					columns: from,
					rows: 200,
					text,
					spinner: {
						frames: ['-'],
					},
				});

				spinner.indent = Math.floor(random() * 8);

				// One cell, so the line above stays a single row at every width
				stream.write('P\n');
				spinner.start();
				stream.columns = to;
				spinner.stop();

				// Widening can clear the whole frame in the replaying test terminal; narrowing cleanup is best effort
				if (to >= from) {
					t.assert.strictEqual(stream.toString(), 'P', `resized ${from} to ${to}`);
				} else {
					t.assert.strictEqual(stream.toString().split('\n', 1)[0], 'P', `resized ${from} to ${to}`);
				}
			}
		}
	}
});

for (const action of ['render', 'clear', 'stop']) {
	test(`narrowing a terminal without cursor line reflow preserves preceding output on ${action}`, t => {
		const state = new TerminalState({columns: 80});
		const stream = getPassThroughStream();
		stream.isTTY = true;
		stream.columns = 80;
		stream.write = content => {
			state.write(String(content));
			return true;
		};

		stream.cursorTo = column => stream.write(`\u{1B}[${column + 1}G`);
		stream.moveCursor = (_column, row) => stream.write(`\u{1B}[${Math.abs(row)}A`);
		stream.clearLine = () => stream.write('\u{1B}[K');

		const {spinner} = createSpinner(t, {
			stream,
			hideCursor: false,
			text: 'x'.repeat(70),
			spinner: {
				frames: ['-'],
			},
		});

		stream.write('PRIOR\n');
		spinner.render();
		t.assert.strictEqual(state.toString(), `PRIOR\n- ${'x'.repeat(70)}`);
		t.assert.strictEqual(spinner._linesToClear, 1);

		stream.columns = 40;
		state.resize(40);
		t.assert.strictEqual(state.cursorPosition.y, 1, 'resizing does not add a row');
		spinner[action]();

		t.assert.ok(state.toString().startsWith('PRIOR'), 'preceding output survives');
		spinner.stop();
		t.assert.strictEqual(state.toString(), 'PRIOR');
	});
}

test('narrowing during a partial write preserves preceding output without cursor line reflow', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const state = new TerminalState({columns: 80});
	const stream = getPassThroughStream();
	stream.isTTY = true;
	stream.columns = 80;
	stream.write = content => {
		state.write(String(content));
		return true;
	};

	stream.cursorTo = column => stream.write(`\u{1B}[${column + 1}G`);
	stream.moveCursor = (_column, row) => stream.write(`\u{1B}[${Math.abs(row)}A`);
	stream.clearLine = () => stream.write('\u{1B}[K');

	const {spinner} = createSpinner(t, {
		stream, hideCursor: false, text: 'working', interval: 100_000,
	});
	stream.write('PRIOR\n');
	spinner.start();
	stream.write('D'.repeat(70));

	stream.columns = 40;
	state.resize(40);
	t.mock.timers.tick(200);

	t.assert.strictEqual(state.toString(), `PRIOR\n${'D'.repeat(40)}`);

	// More writes at the new width must keep rendering paused
	stream.write('D');
	t.mock.timers.tick(200);
	t.assert.strictEqual(state.toString().split('\n', 1)[0], 'PRIOR');

	stream.write('\n');
	t.assert.ok(state.toString().endsWith(`${spinnerCharacter} working`));
});

test('narrowing cleanup is best effort when the cursor line reflows', t => {
	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		// Long enough to wrap once at 80 columns and twice at 40 columns
		text: 'x'.repeat(70),
		// A single frame, so the rendered character cannot change between renders
		spinner: {
			frames: ['⠋'],
		},
	});

	spinner.start();
	t.assert.strictEqual(stream.toString().split('\n').length, 1);

	// Terminals reflow existing output on resize, so the frame now takes two lines
	stream.columns = 40;
	t.assert.strictEqual(stream.toString().split('\n').length, 2);

	spinner.render();

	// Only the recorded row is erased, so part of the previous frame remains above the new frame
	const lines = stream.toString().split('\n');
	t.assert.strictEqual(lines.length, 3);
	t.assert.strictEqual(lines.slice(1).join(''), `⠋ ${'x'.repeat(70)}`);

	spinner.stop();
	t.assert.strictEqual(stream.toString(), lines[0]);
});

test('widening the terminal mid-animation keeps the line above the spinner', t => {
	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		// Wraps to two lines at 40 columns and to one at 80 columns
		text: 'x'.repeat(70),
	});

	stream.write('PRIOR\n');
	spinner.start();

	stream.columns = 80;
	spinner.render();
	spinner.stop();

	t.assert.strictEqual(stream.toString(), 'PRIOR');
});

test('an indented frame that wraps is cleared completely', t => {
	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: '0'.repeat(15),
		indent: 15,
	});

	spinner.start();
	t.assert.strictEqual(spinner._lineCount, 2);
	t.assert.strictEqual(stream.toString().split('\n').length, 2);

	spinner.stop();
	t.assert.strictEqual(stream.toString(), '');
});

test('stop() on a spinner that never started does not move the cursor', t => {
	const {stream, spinner} = createSpinner(t, {text: 'foo'});

	stream.write('progress: 50%');
	const column = stream.getCursorPos().x;

	spinner.stop();
	t.assert.strictEqual(stream.getCursorPos().x, column);
	t.assert.strictEqual(stream.toString(), 'progress: 50%');
});

test('non-string prefix/suffix from functions are ignored', () => {
	const spinner = ora({
		text: 'task',
		prefixText: () => 42,
		suffixText: () => ({x: 1}),
		color: false,
	});

	const frame = spinner.frame();
	assert.ok(!frame.includes('42'));
	assert.ok(!frame.includes('[object Object]'));
});

test('a throwing affix function stops the spinner when an unfinished line ends', t => {
	// Rendering resumes when a newline arrives, and an affix failure must be guarded there too
	const stream = getPassThroughStream();
	stream.isTTY = true;

	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const spinner = ora({
		stream,
		text: 'working',
		color: false,
		isEnabled: true,
		interval: 100_000,
	});

	try {
		spinner.start();

		spinner.prefixText = () => {
			throw new Error('affix boom');
		};

		// The unfinished write pauses rendering until a newline
		stream.write('partial');

		t.mock.timers.tick(200);
		stream.write('\n');

		t.assert.strictEqual(spinner.isSpinning, false, 'the spinner stops itself');
	} finally {
		spinner.stop();
		stream.end();
	}
});

test('a drain draws the frame that waited for it', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		interval: 100_000,
	});

	let isFull = false;
	const passthrough = stream.write.bind(stream);
	stream.write = (chunk, encoding, callback) => {
		passthrough(chunk, encoding, callback);
		return !isFull;
	};

	spinner.start();
	isFull = true;
	spinner.render();
	isFull = false;

	// The stream is full, so the new text waits for the drain
	spinner.text = 'bar';
	spinner.render();
	t.assert.strictEqual(stream.toString(), `${spinnerCharacter} foo`);

	stream.emit('drain');
	t.assert.strictEqual(stream.toString(), `${spinnerCharacter} bar`);
});

test('a throwing affix function in a drain render stops the spinner instead of crashing the process', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	let writes = 0;
	stream.write = () => {
		writes++;
		// Report backpressure so the render waits for a drain
		return false;
	};

	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const spinner = ora({
		stream,
		text: 'working',
		color: false,
		isEnabled: true,
		interval: 100_000,
	});

	try {
		spinner.start();

		spinner.prefixText = () => {
			throw new Error('affix boom');
		};

		// The render that is waiting on a drain must be guarded the same way
		stream.emit('drain');

		t.assert.ok(writes > 0, 'the spinner rendered');
		t.assert.strictEqual(spinner.isSpinning, false, 'the spinner stops itself');
	} finally {
		spinner.stop();
		stream.end();
	}
});

test('a stream that starts failing does not take the process down from a timer render', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	stream.columns = 40;
	stream.rows = 10;
	let isFailing = false;
	stream.write = () => {
		if (isFailing) {
			throw new Error('EPIPE: stream broken');
		}

		return true;
	};

	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const spinner = ora({
		stream,
		text: 'working',
		color: false,
		isEnabled: true,
		discardStdin: false,
		interval: 10,
	});

	try {
		spinner.start();
		isFailing = true;

		// The recovery must not write to the broken stream, or it throws out of the timer callback
		t.mock.timers.tick(10);

		t.assert.strictEqual(spinner.isSpinning, false, 'the spinner stops itself');
	} finally {
		isFailing = false;
		spinner.stop();
	}
});

for (const affix of ['prefixText', 'suffixText']) {
	test(`a throwing ${affix} function stops the spinner instead of crashing the process`, t => {
		t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

		const {stream, spinner} = createSpinner(t, {
			text: 'foo',
			interval: 10,
		});

		spinner.start();
		spinner[affix] = () => {
			throw new Error('affix boom');
		};

		// A throw from the timer callback would be an uncaught exception
		t.mock.timers.tick(10);

		t.assert.strictEqual(spinner.isSpinning, false);

		// The frame that could not be built wrote nothing, so the last one is still there for `stop()`
		t.assert.strictEqual(stream.toString(), `${spinnerCharacter} foo`);
		spinner.stop();
		t.assert.strictEqual(stream.toString(), '');
	});
}

test('a throwing affix function in the render after an external write stops the spinner instead of throwing at the write', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		interval: 100_000,
	});

	spinner.start();
	spinner.prefixText = () => {
		throw new Error('affix boom');
	};

	// The program's own write already went through, so it must not get the spinner's error
	stream.write('hello\n');

	t.assert.strictEqual(spinner.isSpinning, false, 'the spinner stops itself');
	t.assert.strictEqual(stream.toString(), 'hello\n');
});

test('an unfinished line pauses rendering before evaluating affix functions', t => {
	// An unfinished line stays untouched even when building the next frame would throw
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();
	stream.write('partial');
	spinner.suffixText = () => {
		throw new Error('suffix boom');
	};

	t.mock.timers.tick(200);
	t.assert.strictEqual(spinner.isSpinning, true);
	t.assert.strictEqual(stream.toString(), 'partial');
});

test('a throwing affix function rethrows to a direct render() caller', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {spinner} = createSpinner(t, {
		text: 'foo',
		interval: 10,
	});

	spinner.start();
	spinner.suffixText = () => {
		throw new Error('affix boom');
	};

	// An explicit render() call is the user's own code, so the error is theirs to handle
	t.assert.throws(() => {
		spinner.render();
	}, {message: 'affix boom'});

	t.assert.strictEqual(spinner.isSpinning, true, 'a direct render() does not stop the spinner');
});

test('synchronized output ends even when the frame cannot be written', t => {
	// A terminal left in synchronized output mode stops showing anything
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		text: 'foo',
		interval: 100_000,
	});

	const writes = [];
	let isFailing = false;
	const passthrough = stream.write.bind(stream);
	stream.write = (chunk, encoding, callback) => {
		if (isFailing && String(chunk).includes('foo')) {
			throw new Error('EPIPE: stream broken');
		}

		writes.push(String(chunk));
		return passthrough(chunk, encoding, callback);
	};

	spinner.start();
	isFailing = true;

	t.assert.throws(() => {
		spinner.render();
	}, {message: 'EPIPE: stream broken'});

	t.assert.strictEqual(writes.at(-1), synchronizedOutputDisable);
});

test('start() with empty text and isEnabled:false produces no output', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: '',
		color: false,
		isEnabled: false,
	});

	spinner.start();
	stream.end();

	const text = toScreen(await output);
	assert.match(text, /^$/v);
});

// New clear method tests

const currentClearMethod = transFormTTY => {
	const spinner = ora({
		text: 'foo',
		color: false,
		isEnabled: true,
		stream: transFormTTY,
		spinner: {
			frames: [
				'-',
			],
		},
	});

	// The indent is part of the frame content, so clearing only has to erase the lines
	spinner.clear = function () {
		if (!this._isEnabled || !this._stream.isTTY || this._linesToClear === 0) {
			return this;
		}

		this._stream.cursorTo(0);

		for (let index = 0; index < this._linesToClear; index++) {
			if (index > 0) {
				this._stream.moveCursor(0, -1);
			}

			this._stream.clearLine();
		}

		this._linesToClear = 0;

		return this;
	}.bind(spinner);

	return spinner;
};

test('new clear method test, basic', () => {
	const transformTTY = applySynchronizedOutputFilter(new LocalTransformTTY());
	transformTTY.addSequencer();
	transformTTY.addSequencer(null, true);

	/*
	If the frames from this sequence differ from the previous sequence,
	it means the `spinner.clear()` method has failed to fully clear output between calls to render.
	*/

	const currentClearTTY = applySynchronizedOutputFilter(new LocalTransformTTY());
	currentClearTTY.addSequencer();

	const currentOra = currentClearMethod(currentClearTTY);

	const spinner = ora({
		text: 'foo',
		color: false,
		isEnabled: true,
		stream: transformTTY,
		spinner: {
			frames: [
				'-',
			],
		},
	});

	currentOra.render();
	spinner.render();

	currentOra.text = 'bar';
	currentOra.indent = 5;
	currentOra.render();

	spinner.text = 'bar';
	spinner.indent = 5;
	spinner.render();

	currentOra.text = 'baz';
	currentOra.indent = 10;
	currentOra.render();

	spinner.text = 'baz';
	spinner.indent = 10;
	spinner.render();

	currentOra.succeed('boz?');

	spinner.succeed('boz?');

	const [sequenceString, clearedSequenceString] = transformTTY.getSequenceStrings();
	const [frames, clearedFrames] = transformTTY.getFrames();

	assert.strictEqual(sequenceString, '          ✔ boz?\n');
	assert.strictEqual(sequenceString, clearedSequenceString);

	assert.deepStrictEqual(clearedFrames, ['- foo', '     - bar', '          - baz', '          ✔ boz?\n']);
	assert.deepStrictEqual(frames, clearedFrames);

	const currentString = currentClearTTY.getSequenceStrings();

	assert.strictEqual(currentString, '          ✔ boz?\n');

	const currentFrames = currentClearTTY.getFrames();

	assert.deepStrictEqual(frames, currentFrames);
	// Frames created using new clear method are deep equal to frames created using current clear method
});

test('new clear method test, erases wrapped lines', () => {
	const transformTTY = applySynchronizedOutputFilter(new LocalTransformTTY({columns: 40}));
	transformTTY.addSequencer();
	transformTTY.addSequencer(null, true);

	const currentClearTTY = applySynchronizedOutputFilter(new LocalTransformTTY({columns: 40}));
	currentClearTTY.addSequencer();

	const currentOra = currentClearMethod(currentClearTTY);

	const cursorAtRow = () => {
		const cursor = transformTTY.getCursorPos();
		return cursor.y === 0 ? 0 : -cursor.y;
	};

	const clearedLines = () => transformTTY.toString().split('\n').length;

	const spinner = ora({
		text: 'foo',
		color: false,
		isEnabled: true,
		stream: transformTTY,
		spinner: {
			frames: [
				'-',
			],
		},
	});

	currentOra.render();

	spinner.render();
	assert.strictEqual(clearedLines(), 1); // Cleared 'foo'
	assert.strictEqual(cursorAtRow(), 0);

	currentOra.text = 'foo\n\nbar';
	currentOra.render();

	spinner.text = 'foo\n\nbar';
	spinner.render();
	assert.strictEqual(clearedLines(), 3); // Cleared 'foo\n\nbar'
	assert.strictEqual(cursorAtRow(), -2);

	currentOra.clear();
	currentOra.text = '0'.repeat(currentOra._stream.columns + 10);
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.text = '0'.repeat(spinner._stream.columns + 10);
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines(), 2);
	assert.strictEqual(cursorAtRow(), -1);

	currentOra.clear();
	currentOra.text = '🦄'.repeat(currentOra._stream.columns + 10);
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.text = '🦄'.repeat(spinner._stream.columns + 10);
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines(), 3);
	assert.strictEqual(cursorAtRow(), -2);

	currentOra.clear();
	currentOra.text = '🦄'.repeat(currentOra._stream.columns - 2) + '\nfoo';
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.text = '🦄'.repeat(spinner._stream.columns - 2) + '\nfoo';
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines(), 3);
	assert.strictEqual(cursorAtRow(), -2);

	currentOra.clear();
	currentOra.prefixText = 'foo\n';
	currentOra.text = '\nbar';
	currentOra.suffixText = '\nbaz';
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.prefixText = 'foo\n';
	spinner.text = '\nbar';
	spinner.suffixText = '\nbaz';
	spinner.render();
	spinner.render();
	assert.strictEqual(clearedLines(), 4); // Cleared 'foo\n\nbar \nbaz'
	assert.strictEqual(cursorAtRow(), -3);

	const [sequenceString, clearedSequenceString] = transformTTY.getSequenceStrings();
	const [frames, clearedFrames] = transformTTY.getFrames();

	assert.strictEqual(sequenceString, 'foo\n - \nbar \nbaz');
	assert.strictEqual(sequenceString, clearedSequenceString);

	assert.deepStrictEqual(clearedFrames, [
		'- foo',
		'- foo\n\nbar',
		'- 00000000000000000000000000000000000000\n000000000000',
		'- 00000000000000000000000000000000000000\n000000000000',
		'- 🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄',
		'- 🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄',
		'- 🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ 'foo',
		'- 🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ '🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄🦄\n'
		+ 'foo',
		'foo\n - \nbar \nbaz',
		'foo\n - \nbar \nbaz',
	]);

	assert.deepStrictEqual(frames, clearedFrames);

	const currentClearString = currentClearTTY.toString();
	assert.strictEqual(currentClearString, 'foo\n - \nbar \nbaz');

	const currentFrames = currentClearTTY.getFrames();
	assert.deepStrictEqual(frames, currentFrames);
});

test('new clear method, stress test', t => {
	// Freeze `Date.now()` so the frame-throttle in `frame()` is deterministic.
	// Otherwise the two spinners compared below read the wall clock at slightly
	// different instants across 100 renders and drift onto different frames.
	t.mock.timers.enable({apis: ['Date']});

	const rando = (min, max) => {
		min = Math.ceil(min);
		max = Math.floor(max);
		return Math.floor(Math.random() * (max - min)) + min;
	};

	const rAnDoMaNiMaLs = (min, max) => {
		const length = rando(min, max);
		let result = '';
		const THEAMINALS = ['🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐙', '🐵', '🐦', '🐧', '🐔', '🐒', '🙉', '🙈', '🐣', '🐥', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', ...Array.from({length: 5}, () => '\n')];

		for (let i = 0; i < length; i++) {
			result += THEAMINALS[Math.floor(Math.random() * THEAMINALS.length)];
		}

		return result;
	};

	const randos = () => rAnDoMaNiMaLs(rando(5, 15), rando(25, 50));

	const randomize = (s1, s2) => {
		const spnr = spinners.random;
		const txt = randos();
		const indent = rando(0, 15);

		s1.spinner = spnr;
		s2.spinner = spnr;
		s1.text = txt;
		s2.text = txt;
		s1.indent = indent;
		s2.indent = indent;
	};

	const transformTTY = applySynchronizedOutputFilter(new LocalTransformTTY());
	transformTTY.addSequencer();
	transformTTY.addSequencer(null, true);

	const currentClearTTY = applySynchronizedOutputFilter(new LocalTransformTTY());
	currentClearTTY.addSequencer();

	const currentOra = currentClearMethod(currentClearTTY);

	const spinner = ora({
		color: false,
		isEnabled: true,
		stream: transformTTY,
	});

	randomize(spinner, currentOra);

	for (let x = 0; x < 100; x++) {
		if (x % 10 === 0) {
			randomize(spinner, currentOra);
		}

		if (x % 5 === 0) {
			const indent = rando(0, 25);
			spinner.indent = indent;
			currentOra.indent = indent;
		}

		if (x % 15 === 0) {
			let {text} = spinner;
			const loops = rando(1, 10);

			for (let insertion = 0; insertion < loops; insertion++) {
				const pos = Math.floor(Math.random() * text.length);
				text = text.slice(0, pos) + '\n' + text.slice(pos + 1);
			}

			spinner.text = text;
			currentOra.text = text;
		}

		spinner.render();
		currentOra.render();
	}

	spinner.succeed('🙉');
	currentOra.succeed('🙉');

	const currentFrames = currentClearTTY.getFrames();
	const [frames, clearedFrames] = transformTTY.getFrames();

	t.assert.deepStrictEqual(frames, clearedFrames);

	t.assert.deepStrictEqual(frames.slice(0, currentFrames.length), currentFrames);

	// Console.log(frames);
	// console.log(clearFrames);
});
/*
Example output:

[
  '               ▏ \n',
  '               ▎ \n',
  '               ▍ \n',
  '               ▌ \n',
  '               ▋ \n',
  '               ▊ \n',
  '               ▉ \n',
  '               ▊ \n',
  '               ▋ \n',
  '               ▌ \n',
  '   d ',
  '   q ',
  '   p ',
  '   b ',
  '   d ',
  '                 q \n',
  '                 p \n',
  '                 b \n',
  '                 d \n',
  '                 q \n',
  '                ◢ 🐗🐧🐥🐺🐵\n\n',
  '                ◣ 🐗🐧🐥🐺🐵\n\n',
  '                ◤ 🐗🐧🐥🐺🐵\n\n',
  '                ◥ 🐗🐧🐥🐺🐵\n\n',
  '                ◢ 🐗🐧🐥🐺🐵\n\n',
  '                     ◣ 🐗🐧🐥🐺🐵\n\n',
  '                     ◤ 🐗🐧🐥🐺🐵\n\n',
  '                     ◥ 🐗🐧🐥🐺🐵\n\n',
  '                     ◢ 🐗🐧🐥🐺🐵\n\n',
  '                     ◣ 🐗🐧🐥🐺🐵\n\n',
  '      ⠋ \n�🐮�\n\n�\n',
  '      ⠙ \n�🐮�\n\n�\n',
  '      ⠹ \n�🐮�\n\n�\n',
  '      ⠸ \n�🐮�\n\n�\n',
  '      ⠼ \n�🐮�\n\n�\n',
  '                 ⠴ \n�🐮�\n\n�\n',
  '                 ⠦ \n�🐮�\n\n�\n',
  '                 ⠧ \n�🐮�\n\n�\n',
  '                 ⠇ \n�🐮�\n\n�\n',
  '                 ⠏ \n�🐮�\n\n�\n',
  '       □ ',
  '       ■ ',
  '       □ ',
  '       ■ ',
  '       □ ',
  '           ■ \n',
  '           □ \n',
  '           ■ \n',
  '           □ \n',
  '           ■ \n',
  '  .   🐗',
  '  ..  🐗',
  '  ... 🐗',
  '      🐗',
  '  .   🐗',
  '               ..  🐗',
  '               ... 🐗',
  '                   🐗',
  '               .   🐗',
  '               ..  🐗',
  ' ▖ 🐔\n🐸\n',
  ' ▘ 🐔\n🐸\n',
  ' ▝ 🐔\n🐸\n',
  ' ▗ 🐔\n🐸\n',
  ' ▖ 🐔\n🐸\n',
  '  ▘ 🐔\n🐸\n',
  '  ▝ 🐔\n🐸\n',
  '  ▗ 🐔\n🐸\n',
  '  ▖ 🐔\n🐸\n',
  '  ▘ 🐔\n🐸\n',
  '          ( ●    ) 🐔🐗',
  '          (  ●   ) 🐔🐗',
  '          (   ●  ) 🐔🐗',
  '          (    ● ) 🐔🐗',
  '          (     ●) 🐔🐗',
  '(    ● ) �\n\n�',
  '(   ●  ) �\n\n�',
  '(  ●   ) �\n\n�',
  '( ●    ) �\n\n�',
  '(●     ) �\n\n�',
  '     ⧇ 🐷🐛🐔🦁🐷🙉',
  '     ⧆ 🐷🐛🐔🦁🐷🙉',
  '     ⧇ 🐷🐛🐔🦁🐷🙉',
  '     ⧆ 🐷🐛🐔🦁🐷🙉',
  '     ⧇ 🐷🐛🐔🦁🐷🙉',
  '       ⧆ 🐷🐛🐔🦁🐷🙉',
  '       ⧇ 🐷🐛🐔🦁🐷🙉',
  '       ⧆ 🐷🐛🐔🦁🐷🙉',
  '       ⧇ 🐷🐛🐔🦁🐷🙉',
  '       ⧆ 🐷🐛🐔🦁🐷🙉',
  '                        _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        - 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        ` 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                  ` 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  "                  ' 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n",
  '                  ´ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                  - 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                  _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  ... 1 more item
]
[
  '               ▏ \n',
  '               ▎ \n',
  '               ▍ \n',
  '               ▌ \n',
  '               ▋ \n',
  '               ▊ \n',
  '               ▉ \n',
  '               ▊ \n',
  '               ▋ \n',
  '               ▌ \n',
  '   d ',
  '   q ',
  '   p ',
  '   b ',
  '   d ',
  '                 q \n',
  '                 p \n',
  '                 b \n',
  '                 d \n',
  '                 q \n',
  '                ◢ 🐗🐧🐥🐺🐵\n\n',
  '                ◣ 🐗🐧🐥🐺🐵\n\n',
  '                ◤ 🐗🐧🐥🐺🐵\n\n',
  '                ◥ 🐗🐧🐥🐺🐵\n\n',
  '                ◢ 🐗🐧🐥🐺🐵\n\n',
  '                     ◣ 🐗🐧🐥🐺🐵\n\n',
  '                     ◤ 🐗🐧🐥🐺🐵\n\n',
  '                     ◥ 🐗🐧🐥🐺🐵\n\n',
  '                     ◢ 🐗🐧🐥🐺🐵\n\n',
  '                     ◣ 🐗🐧🐥🐺🐵\n\n',
  '      ⠋ \n�🐮�\n\n�\n',
  '      ⠙ \n�🐮�\n\n�\n',
  '      ⠹ \n�🐮�\n\n�\n',
  '      ⠸ \n�🐮�\n\n�\n',
  '      ⠼ \n�🐮�\n\n�\n',
  '                 ⠴ \n�🐮�\n\n�\n',
  '                 ⠦ \n�🐮�\n\n�\n',
  '                 ⠧ \n�🐮�\n\n�\n',
  '                 ⠇ \n�🐮�\n\n�\n',
  '                 ⠏ \n�🐮�\n\n�\n',
  '       □ ',
  '       ■ ',
  '       □ ',
  '       ■ ',
  '       □ ',
  '           ■ \n',
  '           □ \n',
  '           ■ \n',
  '           □ \n',
  '           ■ \n',
  '  .   🐗',
  '  ..  🐗',
  '  ... 🐗',
  '      🐗',
  '  .   🐗',
  '               ..  🐗',
  '               ... 🐗',
  '                   🐗',
  '               .   🐗',
  '               ..  🐗',
  ' ▖ 🐔\n🐸\n',
  ' ▘ 🐔\n🐸\n',
  ' ▝ 🐔\n🐸\n',
  ' ▗ 🐔\n🐸\n',
  ' ▖ 🐔\n🐸\n',
  '  ▘ 🐔\n🐸\n',
  '  ▝ 🐔\n🐸\n',
  '  ▗ 🐔\n🐸\n',
  '  ▖ 🐔\n🐸\n',
  '  ▘ 🐔\n🐸\n',
  '          ( ●    ) 🐔🐗',
  '          (  ●   ) 🐔🐗',
  '          (   ●  ) 🐔🐗',
  '          (    ● ) 🐔🐗',
  '          (     ●) 🐔🐗',
  '(    ● ) �\n\n�',
  '(   ●  ) �\n\n�',
  '(  ●   ) �\n\n�',
  '( ●    ) �\n\n�',
  '(●     ) �\n\n�',
  '     ⧇ 🐷🐛🐔🦁🐷🙉',
  '     ⧆ 🐷🐛🐔🦁🐷🙉',
  '     ⧇ 🐷🐛🐔🦁🐷🙉',
  '     ⧆ 🐷🐛🐔🦁🐷🙉',
  '     ⧇ 🐷🐛🐔🦁🐷🙉',
  '       ⧆ 🐷🐛🐔🦁🐷🙉',
  '       ⧇ 🐷🐛🐔🦁🐷🙉',
  '       ⧆ 🐷🐛🐔🦁🐷🙉',
  '       ⧇ 🐷🐛🐔🦁🐷🙉',
  '       ⧆ 🐷🐛🐔🦁🐷🙉',
  '                        _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        - 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                        ` 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                  ` 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  "                  ' 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n",
  '                  ´ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                  - 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  '                  _ 🐽🦄🐣\n🐣🐧🐔🦁🐦�\n',
  ... 1 more item
]
*/

test('multiline text exceeding console height', () => {
	// Create a mock stream with limited height
	const stream = getPassThroughStream();
	stream.rows = 5; // Simulate a console with 5 rows
	stream.columns = 80;
	stream.isTTY = true;

	let writtenContent = '';

	// Override write to capture content
	const originalWrite = stream.write;
	stream.write = function (content) {
		writtenContent += String(content);
		return originalWrite.call(this, content);
	};

	const spinner = ora({
		stream,
		text: Array.from({length: 10}, (_, i) => `Line ${i + 1}`).join('\n'), // 10 lines (exceeds 5 row height)
		color: false,
		isEnabled: true,
	});

	spinner.start();
	spinner.render(); // Force a render

	const renderedOutput = stripVTControlCharacters(getLastSynchronizedOutput(writtenContent));

	// When content exceeds viewport, should truncate with message
	assert.ok(renderedOutput.includes('Line 1'), 'Should include some original content');
	assert.ok(renderedOutput.includes('(content truncated to fit terminal)'), 'Should show truncation message');

	// Should not include all 10 lines
	const lineCount = (renderedOutput.match(/Line \d+/gv) || []).length;
	assert.ok(lineCount < 10, 'Should truncate some lines');
	assert.ok(lineCount <= 5, 'Should not exceed terminal height');

	spinner.stop();
});

test('multiline text with undefined terminal rows (no truncation)', () => {
	// Test fallback behavior when stream.rows is undefined
	const stream = getPassThroughStream();
	delete stream.rows; // Ensure rows is undefined
	stream.columns = 80;
	stream.isTTY = true;

	let writtenContent = '';

	// Override write to capture content
	const originalWrite = stream.write;
	stream.write = function (content) {
		writtenContent += String(content);
		return originalWrite.call(this, content);
	};

	const spinner = ora({
		stream,
		text: Array.from({length: 10}, (_, i) => `Line ${i + 1}`).join('\n'),
		color: false,
		isEnabled: true,
	});

	spinner.start();
	spinner.render();

	// When terminal height is unknown, should not truncate (no truncation applied)
	const renderedOutput = stripVTControlCharacters(getLastSynchronizedOutput(writtenContent));
	assert.ok(renderedOutput.includes('Line 1'), 'Should include first line');
	assert.ok(renderedOutput.includes('Line 10'), 'Should include last line');
	assert.ok(!renderedOutput.includes('(content truncated to fit terminal)'), 'Should not truncate when height is unknown');

	spinner.stop();
});

test('multiline text with very small console height (no truncation)', () => {
	// Test edge case: console height = 1 (should not truncate since no room for message)
	const stream = getPassThroughStream();
	stream.rows = 1;
	stream.columns = 80;
	stream.isTTY = true;

	let writtenContent = '';
	const originalWrite = stream.write;
	stream.write = function (content) {
		writtenContent += String(content);
		return originalWrite.call(this, content);
	};

	const spinner = ora({
		stream,
		text: 'Line 1\nLine 2\nLine 3', // 3 lines (exceeds 1 row height)
		color: false,
		isEnabled: true,
	});

	spinner.start();
	spinner.render();

	// When console is too small (1 row), should not truncate because no room for message
	const renderedOutput = stripVTControlCharacters(getLastSynchronizedOutput(writtenContent));
	assert.ok(renderedOutput.includes('Line 1'), 'Should include content');
	assert.ok(!renderedOutput.includes('(content truncated to fit terminal)'), 'Should not truncate when console too small for message');

	spinner.stop();
});

test('interval validation works correctly', () => {
	const spinner = ora({isEnabled: false, interval: 200});
	assert.strictEqual(spinner.interval, 200);

	// Interval is read-only, set via constructor or spinner object
	const spinner2 = ora({isEnabled: false});
	spinner2.spinner = {frames: ['a', 'b'], interval: 150};
	assert.strictEqual(spinner2.interval, 150);
});

test('interval rejects negative values', () => {
	assert.throws(() => {
		ora({interval: -100});
	}, {message: /positive integer/v});
});

test('interval rejects non-integer values', () => {
	assert.throws(() => {
		ora({interval: 1.5});
	}, {message: /positive integer/v});
});

test('interval rejects zero', () => {
	assert.throws(() => {
		ora({interval: 0});
	}, {message: /positive integer/v});
});

test('color rejects invalid color names', () => {
	assert.throws(() => {
		ora({color: 'invalid'});
	}, {message: /valid color/v});
});

test('color rejects non-string non-false values', () => {
	assert.throws(() => {
		ora({color: 123});
	}, {message: /valid color/v});
});

test('color accepts false to disable', () => {
	const spinner = ora({color: false, isEnabled: false});
	assert.strictEqual(spinner.color, false);
});

test('color accepts valid color names', () => {
	const spinner = ora({color: 'red', isEnabled: false});
	assert.strictEqual(spinner.color, 'red');
});

test('color accepts undefined', () => {
	const spinner = ora({color: undefined, isEnabled: false});
	assert.strictEqual(spinner.color, undefined);
});

test('color setter accepts undefined', () => {
	const spinner = ora({color: 'green', isEnabled: false});
	spinner.color = undefined;
	assert.strictEqual(spinner.color, undefined);
});

test('text setter handles falsy values correctly', () => {
	const spinner = ora({color: false});
	spinner.text = null;
	assert.strictEqual(spinner.text, null); // Null is kept as null
	spinner.text = undefined;
	assert.strictEqual(spinner.text, ''); // Undefined becomes empty string
	spinner.text = 0;
	assert.strictEqual(spinner.text, 0); // Number 0 is kept as-is
	spinner.text = false;
	assert.strictEqual(spinner.text, false); // Boolean false is kept as-is
});

test('frameIndex wraps around correctly', t => {
	t.mock.timers.enable({apis: ['Date']});

	const spinner = ora({
		text: 'x',
		spinner: {frames: ['a', 'b', 'c'], interval: 10},
		color: false,
		isEnabled: false,
	});

	// A frame only advances once the interval has passed
	const frames = [];
	for (let index = 0; index < 4; index++) {
		frames.push(spinner.frame());
		t.mock.timers.tick(10);
	}

	t.assert.deepStrictEqual(frames, ['a x', 'b x', 'c x', 'a x']);
});

test('nested spinners do not interfere', () => {
	const stream1 = getPassThroughStream();
	const stream2 = getPassThroughStream();

	const spinner1 = ora({stream: stream1, text: 'first', isEnabled: true});
	const spinner2 = ora({stream: stream2, text: 'second', isEnabled: true});

	spinner1.start();
	spinner2.start();

	assert.ok(spinner1.isSpinning);
	assert.ok(spinner2.isSpinning);

	// Stop them independently
	spinner1.stop();
	assert.ok(!spinner1.isSpinning);
	assert.ok(spinner2.isSpinning);

	spinner2.stop();
	assert.ok(!spinner2.isSpinning);
});

test('the stream hook is removed after two spinners on the same stream are stopped', t => {
	// Concurrent spinners are unsupported, but the damage must not outlive them
	const stream = new LocalTransformTTY();
	const originalWrite = stream.write;

	const [spinner1, spinner2] = ['one', 'two'].map(text => ora({
		stream,
		text,
		color: false,
		isEnabled: true,
		discardStdin: false,
	}));

	t.mock.method(console, 'warn', noop);

	t.after(() => {
		spinner1.stop();
		spinner2.stop();
	});

	spinner1.start();
	spinner2.start();

	// The first one to start is also the first one stopped
	spinner1.stop();
	t.assert.notStrictEqual(stream.write, originalWrite, 'the spinner that still runs keeps its hook');
	spinner2.stop();

	// A stopped spinner's hook must not stay wrapped around the stream
	t.assert.strictEqual(stream.write, originalWrite);
});

test('the stream hook is removed when two spinners on the same stream stop in reverse order', t => {
	const stream = new LocalTransformTTY();
	const originalWrite = stream.write;

	const [spinner1, spinner2] = ['one', 'two'].map(text => ora({
		stream,
		text,
		color: false,
		isEnabled: true,
		discardStdin: false,
	}));

	t.mock.method(console, 'warn', noop);

	t.after(() => {
		spinner1.stop();
		spinner2.stop();
	});

	spinner1.start();
	spinner2.start();

	// The last one to start stops first, so its hook is the one wrapped around the other
	spinner2.stop();
	spinner1.stop();

	t.assert.strictEqual(stream.write, originalWrite);
});

test('a spinner started after two others on the same stream is cleaned up', t => {
	const stream = new LocalTransformTTY();
	const originalWrite = stream.write;

	const makeSpinner = text => ora({
		stream,
		text,
		color: false,
		isEnabled: true,
		discardStdin: false,
	});

	const spinner1 = makeSpinner('one');
	const spinner2 = makeSpinner('two');

	t.mock.method(console, 'warn', noop);

	t.after(() => {
		spinner1.stop();
		spinner2.stop();
	});

	spinner1.start();
	spinner2.start();
	spinner1.stop();
	spinner2.stop();

	// A later spinner must not capture a stale hook as its "original" write
	const spinner3 = makeSpinner('three');
	spinner3.start();
	spinner3.stop();

	t.assert.strictEqual(stream.write, originalWrite);
});

test('rapid state changes preserve final state', () => {
	const spinner = ora({isEnabled: false});
	spinner.start();
	spinner.succeed();
	spinner.fail();
	spinner.warn();
	spinner.info();
	assert.ok(!spinner.isSpinning);
});

test('disabled spinner preserves prefix/suffix/indent', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: 'test',
		prefixText: 'pre',
		suffixText: 'post',
		indent: 2,
		color: false,
		isEnabled: false,
	});

	spinner.start();
	stream.end();

	const text = toScreen(await output);
	assert.strictEqual(text, '  pre - test post\n');
});

test('disabled spinner with empty text has no doubled space between the affixes', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: '',
		prefixText: 'pre',
		suffixText: 'post',
		indent: 2,
		color: false,
		isEnabled: false,
	});

	spinner.start();
	stream.end();

	// Without a symbol or text, the affixes are joined by a single space
	assert.strictEqual(toScreen(await output), '  pre post\n');
});

test('disabled spinner with empty text and only a prefix has no trailing space', async () => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = ora({
		stream,
		text: '',
		prefixText: 'pre',
		indent: 2,
		color: false,
		isEnabled: false,
	});

	spinner.start();
	stream.end();

	assert.strictEqual(toScreen(await output), '  pre\n');
});

test('emoji text handled correctly', () => {
	const spinner = ora({
		text: '🚀 Loading 🎉',
		color: false,
		isEnabled: false,
	});

	const frame = spinner.frame();
	assert.ok(frame.includes('🚀 Loading 🎉'));
});

test('spinner property returns current spinner', () => {
	const customSpinner = {frames: ['a', 'b'], interval: 100};
	const spinner = ora({spinner: customSpinner, isEnabled: false});

	assert.deepStrictEqual(spinner.spinner, customSpinner);

	spinner.spinner = 'dots';
	assert.strictEqual(spinner.spinner.frames.length, spinners.dots.frames.length);
});

test('color persists through spinner changes', () => {
	const spinner = ora({color: 'blue', isEnabled: false});
	assert.strictEqual(spinner.color, 'blue');

	spinner.spinner = 'dots';
	assert.strictEqual(spinner.color, 'blue');
});

test('oraPromise handles sync exceptions', async () => {
	await assert.rejects(async () => {
		await oraPromise(() => {
			throw new Error('sync error');
		}, {isEnabled: false});
	}, {message: 'sync error'});
});

test('handles external writes to stream while spinning', () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const writes = [];

	// Track all writes
	const originalWrite = stream.write;
	stream.write = function (content, encoding, callback) {
		writes.push(stripVTControlCharacters(content.toString()));
		return originalWrite.call(this, content, encoding, callback);
	};

	const spinner = ora({
		stream,
		text: 'spinning',
		color: false,
		isEnabled: true,
	});

	spinner.start();

	// Simulate external write (like console.log)
	stream.write('External log\n');

	spinner.succeed('done');

	// Verify all content appears in output
	assert.ok(writes.some(w => w.includes('External log')), 'External write should be captured');
	assert.ok(writes.some(w => w.includes('spinning')), 'Spinner text should be present');
	assert.ok(writes.some(w => w.includes('done')), 'Success text should be present');

	// Verify ordering: external log appears before success message
	const externalIndex = writes.findIndex(w => w.includes('External log'));
	const doneIndex = writes.findIndex(w => w.includes('done'));
	assert.notStrictEqual(externalIndex, -1, 'the external log should exist');
	assert.notStrictEqual(doneIndex, -1, 'the done message should exist');
	assert.ok(externalIndex < doneIndex, 'External log should appear before done message');

	stream.end();
});

test('handles multiple external writes while spinning', () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const writes = [];

	const originalWrite = stream.write;
	stream.write = function (content, encoding, callback) {
		writes.push(stripVTControlCharacters(content.toString()));
		return originalWrite.call(this, content, encoding, callback);
	};

	const spinner = ora({
		stream,
		text: 'processing',
		color: false,
		isEnabled: true,
	});

	spinner.start();

	// Multiple external writes
	stream.write('Log 1\n');
	stream.write('Log 2\n');
	stream.write('Log 3\n');

	spinner.stop();

	// All logs should be present
	assert.ok(writes.some(w => w.includes('Log 1')), 'First log should be present');
	assert.ok(writes.some(w => w.includes('Log 2')), 'Second log should be present');
	assert.ok(writes.some(w => w.includes('Log 3')), 'Third log should be present');

	// Verify ordering
	const log1Index = writes.findIndex(w => w.includes('Log 1'));
	const log2Index = writes.findIndex(w => w.includes('Log 2'));
	const log3Index = writes.findIndex(w => w.includes('Log 3'));

	assert.ok(log1Index < log2Index, 'Log 1 should appear before Log 2');
	assert.ok(log2Index < log3Index, 'Log 2 should appear before Log 3');

	stream.end();
});

test('a line written in multiple chunks is not rewound by cursor control', t => {
	// A stream with real cursor methods, since raw output cannot show rewinds
	const {stream, spinner} = createSpinner(t, {text: 'loading'});

	spinner.start();
	stream.write('Downloading ');
	stream.write('42%\n');
	spinner.stop();

	t.assert.strictEqual(stream.toString(), 'Downloading 42%');
});

test('the first frame is rendered from the start of the line', t => {
	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: 'x'.repeat(15),
	});

	// Output without a trailing newline leaves the cursor in the middle of the line
	stream.write('123456789012');

	spinner.start();
	t.assert.strictEqual(stream.toString(), `${spinnerCharacter} ${'x'.repeat(15)}`);

	spinner.stop();
	t.assert.strictEqual(stream.toString(), '');
});

test('a carriage return in the text does not clear the line above the spinner', t => {
	const {stream, spinner} = createSpinner(t, {
		columns: 10,
		// The text after the carriage return overwrites the text before it
		text: 'aaaaaa\rbbbbbb',
	});

	stream.write('PRIOR\n');
	spinner.start();
	spinner.stop();

	t.assert.strictEqual(stream.toString(), 'PRIOR');
});

test('an external write erases the frame when output was disabled while spinning', t => {
	const {stream, spinner} = createSpinner(t, {text: 'foo'});

	spinner.start();
	spinner.isEnabled = false;
	stream.write('log\n');
	spinner.stop();

	t.assert.strictEqual(stream.toString(), 'log\n');
});

test('a carriage return does not let the spinner overwrite the partial line', t => {
	// Progress output rewrites the current line, so the last value must survive the spinner
	const {stream, spinner} = createSpinner(t, {text: 'working'});

	spinner.start();
	stream.write('100%\r');
	spinner.stop();

	t.assert.strictEqual(stream.toString(), '100%');
});

test('external writes preserve chunk boundaries without injecting newlines', async () => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const outputPromise = getStream(stream);
	const originalWrite = stream.write;

	const spinner = ora({
		stream,
		text: 'processing',
		color: false,
		isEnabled: true,
	});

	spinner.start();
	assert.notStrictEqual(stream.write, originalWrite, 'hook should wrap stream.write');

	stream.write('Downloading ');
	stream.write('42%');
	stream.write('\n');

	spinner.stop();
	assert.strictEqual(stream.write, originalWrite, 'hook should restore original stream.write');
	stream.end();

	const outputRaw = await outputPromise;
	const stripped = stripVTControlCharacters(outputRaw.toString().replaceAll('\r', ''));

	assert.ok(stripped.includes('Downloading 42%\n'), 'line should remain intact without injected newline');
	assert.ok(!stripped.includes('Downloading \n42%'), 'should not inject newline between partial chunks');
});

test('partial external writes pause spinner renders until newline', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;

	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const spinner = ora({
		stream,
		text: 'processing',
		color: false,
		isEnabled: true,
		interval: 80,
	});

	try {
		spinner.start();
		t.mock.timers.tick(80);

		const baselineFrameIndex = spinner._frameIndex;

		stream.write('Partial chunk without newline');
		t.mock.timers.tick(199);
		t.assert.strictEqual(spinner._frameIndex, baselineFrameIndex, 'frame index should not advance while the line is unfinished');

		stream.write('\n');
		t.assert.ok(spinner._frameIndex > baselineFrameIndex, 'newline should resume rendering immediately');
		const afterNewlineFrameIndex = spinner._frameIndex;

		stream.write('Another partial chunk');
		t.mock.timers.tick(199);
		t.assert.strictEqual(spinner._frameIndex, afterNewlineFrameIndex, 'second partial chunk should defer renders again');

		t.mock.timers.tick(10_000);
		t.assert.strictEqual(spinner._frameIndex, afterNewlineFrameIndex, 'elapsed time must not resume rendering over an unfinished line');
		stream.write('\n');
		t.assert.ok(spinner._frameIndex > afterNewlineFrameIndex, 'newline resumes rendering after a long pause');
	} finally {
		spinner.stop();
		stream.end();
	}
});

test('colored external lines resume spinner rendering after trailing styling codes', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
	const {stream, spinner} = createSpinner(t, {
		text: 'working',
		spinner: {frames: ['a', 'b', 'c'], interval: 80},
	});
	spinner.start();

	stream.write('\u{1B}[31mhello\n\u{1B}[39m');
	t.assert.strictEqual(stream.toString(), 'hello\na working');
	t.mock.timers.tick(80);
	t.assert.strictEqual(stream.toString(), 'hello\nb working');
});

test('a buffer write is classified by its decoded newline, like a string write', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	stream.columns = 80;
	stream.rows = 25;

	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	// The classification controls how many frames are written
	let frames = 0;
	const originalWrite = stream.write;
	stream.write = function (content, ...rest) {
		if (String(content).includes('processing')) {
			frames++;
		}

		return originalWrite.call(this, content, ...rest);
	};

	const spinner = ora({
		stream,
		text: 'processing',
		color: false,
		isEnabled: true,
		interval: 80,
	});

	try {
		spinner.start();
		t.mock.timers.tick(80);

		const framesAfterStart = frames;

		// A buffer that does not end the line defers the render
		stream.write(Buffer.from('Partial chunk without newline'));
		t.mock.timers.tick(199);
		t.assert.strictEqual(frames, framesAfterStart, 'a buffer without a newline defers the render');

		// A buffer that ends the line resumes it
		stream.write(Buffer.from('\n'));
		t.assert.ok(frames > framesAfterStart, 'a buffer with a newline resumes rendering');
	} finally {
		spinner.stop();
		stream.end();
	}
});

test('succeed() keeps a partial line that is still being written and starts on the line after it', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {text: 'working'});

	spinner.start();

	// The line is not finished, so Ora keeps out of the way until a newline
	stream.write('Downloading 42');
	spinner.succeed('done');

	// The partial line stays, and the result is not appended to it
	t.assert.strictEqual(stream.toString(), 'Downloading 42\n✔ done\n');
});

test('stop() leaves a partial line that is still being written on screen', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {text: 'working'});

	spinner.start();
	stream.write('Downloading 42');
	spinner.stop();

	// `stop()` only clears its own frame, so the unfinished line stays
	t.assert.strictEqual(stream.toString(), 'Downloading 42');
});

test('split UTF-8 buffer writes are never replayed as decoded strings', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const writes = [];
	stream.write = content => {
		writes.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
		return true;
	};

	const {spinner} = createSpinner(t, {
		stream, hideCursor: false, text: 'working', interval: 100_000,
	});
	spinner.start();
	writes.length = 0;

	const bytes = Buffer.from('🦄');
	stream.write(bytes.subarray(0, 2));
	stream.write(bytes.subarray(2));
	t.mock.timers.tick(200);
	spinner.stop();

	t.assert.strictEqual(stripVTControlCharacters(Buffer.concat(writes).toString()), '🦄');
});

test('unfinished output taller than the viewport is not replayed', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
	const {stream, spinner} = createSpinner(t, {
		columns: 10, rows: 3, text: 'working', interval: 100_000,
	});
	const writes = [];
	const originalWrite = stream.write;
	stream.write = function (content, ...arguments_) {
		writes.push(String(content));
		return originalWrite.call(this, content, ...arguments_);
	};

	spinner.start();
	stream.write('D'.repeat(50));
	t.mock.timers.tick(200);
	stream.write('\n');
	spinner.stop();

	t.assert.strictEqual(writes.join('').split('D').length - 1, 50, 'each character is written once, including rows in scrollback');
});

test('a line split across a pause keeps the part that was already written', t => {
	// The whole line stays on screen while rendering is paused
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	// Part of the line, then a gap between writes
	stream.write('li');
	t.mock.timers.tick(200);

	// The rest of the line
	stream.write('ne 0\n');
	spinner.stop();

	// The whole line is there, including the part before the pause
	t.assert.strictEqual(stream.toString().trimEnd(), 'line 0');
});

test('a line split across several pauses keeps every part that was already written', t => {
	// Every chunk remains untouched while the line is unfinished
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	stream.write('Downloading');
	t.mock.timers.tick(200);
	stream.write(' 50%');
	t.mock.timers.tick(200);
	stream.write(' done\n');
	spinner.stop();

	t.assert.strictEqual(stream.toString().trimEnd(), 'Downloading 50% done');
});

test('an empty write does not resume rendering over an unfinished line', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	stream.write('Downloading');
	t.mock.timers.tick(200);
	stream.write('');

	// An empty write does not finish the line, so the spinner stays paused
	t.assert.strictEqual(stream.toString(), 'Downloading');

	stream.write(' done\n');
	spinner.stop();

	t.assert.strictEqual(stream.toString().trimEnd(), 'Downloading done');
});

test('stop() preserves an unfinished line after a pause', t => {
	// Stopping the spinner leaves the line as the program wrote it
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	stream.write('Result: ');
	t.mock.timers.tick(200);
	spinner.stop();
	stream.write('42\n');

	t.assert.strictEqual(stream.toString(), 'Result: 42\n');
});

test('a partial line survives when the rest of it arrives after the spinner stops', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {text: 'working'});

	spinner.start();
	stream.write('Downloading 42');
	spinner.stop();
	stream.write('%\n');

	t.assert.strictEqual(stream.toString(), 'Downloading 42%\n');
});

test('more writes to an unfinished line keep rendering paused', t => {
	// A growing line stays untouched until a newline arrives
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		text: 'working',
		interval: 100_000,
	});

	spinner.start();
	stream.write('Down');
	t.mock.timers.tick(150);
	stream.write('loading');
	t.mock.timers.tick(50);

	t.assert.strictEqual(stream.toString(), 'Downloading');
});

test('the spinner leaves an unfinished line untouched across timer ticks', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	// The line is longer than the frame that replaces it
	stream.write('Downloading a rather long partial line');
	t.mock.timers.tick(200);

	// The unfinished line is not replaced by a frame
	t.assert.strictEqual(stream.toString(), 'Downloading a rather long partial line');
});

test('a partial line that wraps stays untouched across timer ticks', t => {
	// Every row of a wrapped partial line stays untouched
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// 60 characters wrap onto three rows at 20 columns
	stream.write('D'.repeat(60));
	t.mock.timers.tick(200);

	// The preceding output and every row of the unfinished line stay visible
	t.assert.strictEqual(stream.toString(), `PRIOR\n${'D'.repeat(20)}\n${'D'.repeat(20)}\n${'D'.repeat(20)}`);
});

test('succeed() preserves a wrapped unfinished line after a pause', t => {
	// The unfinished line stays visible, and the result starts on the next row
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// 60 characters wrap onto three rows at 20 columns
	stream.write('D'.repeat(60));
	t.mock.timers.tick(200);
	spinner.succeed('done');

	t.assert.strictEqual(stream.toString(), `PRIOR\n${'D'.repeat(20)}\n${'D'.repeat(20)}\n${'D'.repeat(20)}\n✔ done\n`);
});

test('a stopped spinner does not erase a line written after it stopped', t => {
	// The unfinished-line state belongs to the previous run
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		text: 'work',
		interval: 100_000,
	});

	spinner.start();
	stream.write('Downloading 42');
	spinner.stop();

	// Ordinary output after the spinner stopped
	stream.write(' ok');

	// Starting again must not erase the output from the previous run
	spinner.start();
	t.assert.ok(stream.toString().endsWith(' ok'), `the output line must survive, got ${JSON.stringify(stream.toString())}`);
});

test('unfinished lines after control characters remain untouched', t => {
	// Newlines and carriage returns must not let the spinner overwrite the unfinished tail
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const cases = [
		// A carriage return resets the column, so the tail is one row
		'abcdefghij\rzz\r\n' + 'z'.repeat(12),
		// `\r\n` starts the next row at column zero, so the tail is one row
		'ab\r\n' + 'z'.repeat(19),
		// The newline after the tab resets the column
		'abcdefg\t\nbbbbbbbbbbbbbb',
		// The line filled the row, and the tail starts on the next one
		'x'.repeat(20) + '\nc',
		// A line that wrapped is finished, but its tail is still unfinished
		'x'.repeat(45) + '\ndone',
		// A tail wider than the row wraps from its start
		'x'.repeat(15) + '\n' + 'y'.repeat(25),
	];

	for (const external of cases) {
		const {stream, spinner} = createSpinner(t, {
			columns: 20,
			rows: 10,
			text: 'S',
			interval: 100_000,
			spinner: {
				frames: ['#'],
			},
		});

		spinner.start();
		stream.write(external);

		const before = stream.toString();
		t.mock.timers.tick(1000);
		t.assert.strictEqual(stream.toString(), before, `unfinished output stays untouched for ${JSON.stringify(external)}`);

		spinner.stop();
	}
});

test('finished lines before an unfinished one stay untouched', t => {
	// Neither finished lines nor the unfinished tail belong to the spinner
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		rows: 8,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	stream.write('PRIOR\n');
	stream.write('Step 1 finished, now starting step 2\nProgress: 12%');
	t.mock.timers.tick(200);

	t.assert.strictEqual(stream.toString(), 'PRIOR\nStep 1 finished, now starting step 2\nProgress: 12%');
});

test('a partial write with newlines stays untouched until its tail ends', t => {
	// Finished lines and the unfinished tail must stay on screen
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		text: 'working',
		interval: 100_000,
	});

	spinner.start();

	// Two finished lines and one unfinished line
	stream.write('line one\nline two\npart');
	t.mock.timers.tick(200);

	t.assert.strictEqual(stream.toString(), 'line one\nline two\npart');

	// Stopping does not replay any of the finished or unfinished output
	spinner.stop();
	stream.write('ial\n');

	t.assert.strictEqual(stream.toString(), 'line one\nline two\npartial\n');
});

test('a partial line is left alone after a resize', t => {
	// Reflow varies by terminal, so the spinner waits for the unfinished line to end
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 40,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// One row at forty columns, three rows at twelve
	stream.write('a partial line that is quite long in total');
	stream.columns = 12;
	t.mock.timers.tick(200);

	t.assert.strictEqual(stream.toString(), 'PRIOR\na partial li\nne that is q\nuite long in\n total');
});

test('a partial line written in several chunks stays untouched', t => {
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// Every chunk stays visible without being retained for replay
	stream.write('D'.repeat(15));
	stream.write('D'.repeat(15));
	stream.write('D'.repeat(15));
	t.mock.timers.tick(200);

	t.assert.strictEqual(stream.toString(), `PRIOR\n${'D'.repeat(20)}\n${'D'.repeat(20)}\n${'D'.repeat(5)}`);
});

test('a partial line written in chunks that each fill a row stays untouched', t => {
	// Chunks that fill a row exactly must not cause the spinner to overwrite the next one
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// Forty characters fill two rows exactly, and five more start a third
	stream.write('D'.repeat(20));
	stream.write('D'.repeat(20));
	stream.write('D'.repeat(5));
	t.mock.timers.tick(200);

	t.assert.strictEqual(stream.toString(), `PRIOR\n${'D'.repeat(20)}\n${'D'.repeat(20)}\n${'D'.repeat(5)}`);
});

test('a partial line is left alone when the terminal is resized between two writes', t => {
	// Writing at the new width does not finish the line
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 80,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// 200 characters take three rows at 80 columns and twenty one at 10
	stream.write('D'.repeat(200));
	stream.columns = 10;
	stream.write('D');
	t.mock.timers.tick(200);

	t.assert.strictEqual(stream.toString(), `PRIOR\n${('D'.repeat(10) + '\n').repeat(20)}D`);
});

test('a partial line split inside an escape sequence keeps rendering paused', t => {
	// A write can end in the middle of an escape sequence or a grapheme, which cannot be measured until the next chunk arrives
	t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});

	const {stream, spinner} = createSpinner(t, {
		columns: 20,
		text: 'working',
		interval: 100_000,
	});

	stream.write('PRIOR\n');
	spinner.start();

	// The first chunk stops inside the color sequence, and the next chunk still leaves the line unfinished
	stream.write('\u{1B}[3;');
	stream.write(`32m${'X'.repeat(18)}`);

	const before = stream.toString();
	t.mock.timers.tick(1000);
	t.assert.strictEqual(stream.toString(), before);
});

test('handles stream write errors gracefully', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	const writes = [];

	// Wrap the real write to optionally throw
	let shouldThrow = false;
	const realWrite = stream.write;
	stream.write = function (...arguments_) {
		if (shouldThrow) {
			throw new Error('Stream write error');
		}

		writes.push(String(arguments_[0]));
		return realWrite.apply(this, arguments_);
	};

	// Like the readline ones, the cursor methods write to the stream, so the erase goes through the spinner's internal writes
	stream.cursorTo = () => stream.write('\u{1B}[G');

	const {spinner} = createSpinner(t, {stream, text: 'test'});

	spinner.start();
	// Hook now wraps our throwing wrapper

	// Enable throwing - this will cause cursor operations in clear() to throw
	shouldThrow = true;

	// External write triggers hook -> clear() -> cursorTo() -> our wrapper throws
	t.assert.throws(() => {
		stream.write('External write');
	}, {message: 'Stream write error'});

	// Disable throwing
	shouldThrow = false;
	writes.length = 0;

	// If the internal write flag was stuck at true, this external write would pass through as internal, and no frame would be drawn after it
	stream.write('Should work now\n');
	t.assert.ok(writes.indexOf('Should work now\n') < writes.findLastIndex(write => write.includes('test')), 'the frame is drawn after the external write');
});

test('hooks both stdout and stderr', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;

	// Only a terminal is hooked, and the test runner pipes both streams
	const originalStdoutIsTTY = process.stdout.isTTY;
	const originalStderrIsTTY = process.stderr.isTTY;
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	process.stdout.isTTY = true;
	process.stderr.isTTY = true;

	let spinner;
	try {
		spinner = ora({
			stream,
			text: 'processing',
			color: false,
			isEnabled: true,
			discardStdin: false,
		});

		spinner.start();
		t.assert.notStrictEqual(process.stdout.write, originalStdoutWrite, 'stdout is hooked');
		t.assert.notStrictEqual(process.stderr.write, originalStderrWrite, 'stderr is hooked');

		spinner.stop();
		t.assert.strictEqual(process.stdout.write, originalStdoutWrite, 'stdout is restored');
		t.assert.strictEqual(process.stderr.write, originalStderrWrite, 'stderr is restored');
	} finally {
		// The spinner has to give back its hooks before the streams are restored
		spinner?.stop();

		// Restore original write methods
		process.stdout.isTTY = originalStdoutIsTTY;
		process.stderr.isTTY = originalStderrIsTTY;
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
});
