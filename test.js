import process from 'node:process';
import {PassThrough as PassThroughStream} from 'node:stream';
import getStream from 'get-stream';
import test from 'ava';
import stripAnsi from 'strip-ansi';
import TransformTTY from 'transform-tty';
import ora, {oraPromise, spinners} from './index.js';

const spinnerCharacter = process.platform === 'win32' ? '-' : '⠋';
const noop = () => {};

const getPassThroughStream = () => {
	const stream = new PassThroughStream();
	stream.clearLine = noop;
	stream.cursorTo = noop;
	stream.moveCursor = noop;
	return stream;
};

const doSpinner = async (function_, extraOptions = {}) => {
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

	return stripAnsi(await output);
};

const macro = async (t, function_, expected, extraOptions = {}) => {
	t.regex(await doSpinner(function_, extraOptions), expected);
};

test('main', macro, spinner => {
	spinner.stop();
}, new RegExp(`${spinnerCharacter} foo`));

test('`.id` is not set when created', t => {
	const spinner = ora('foo');
	t.false(spinner.isSpinning);
});

test('ignore consecutive calls to `.start()`', t => {
	const spinner = ora('foo');
	spinner.start();
	const {id} = spinner;
	spinner.start();
	t.is(id, spinner.id);
});

test('chain call to `.start()` with constructor', t => {
	const spinner = ora({
		stream: getPassThroughStream(),
		text: 'foo',
		isEnabled: true,
	}).start();

	t.truthy(spinner.isSpinning);
	t.true(spinner._isEnabled);
});

test('.succeed()', macro, spinner => {
	spinner.succeed();
}, /[√✔] foo\n$/);

test('.succeed() - with new text', macro, spinner => {
	spinner.succeed('fooed');
}, /[√✔] fooed\n$/);

test('.fail()', macro, spinner => {
	spinner.fail();
}, /[×✖] foo\n$/);

test('.fail() - with new text', macro, spinner => {
	spinner.fail('failed to foo');
}, /[×✖] failed to foo\n$/);

test('.warn()', macro, spinner => {
	spinner.warn();
}, /[‼⚠] foo\n$/);

test('.info()', macro, spinner => {
	spinner.info();
}, /[iℹ] foo\n$/);

test('.stopAndPersist() - with new text', macro, spinner => {
	spinner.stopAndPersist({text: 'all done'});
}, /\s all done\n$/);

test('.stopAndPersist() - with new symbol and text', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'all done'});
}, /@ all done\n$/);

test('.start(text)', macro, spinner => {
	spinner.start('Test text');
	spinner.stopAndPersist();
}, /Test text\n$/);

test('.start() - isEnabled:false outputs text', macro, spinner => {
	spinner.stop();
}, /- foo\n$/, {isEnabled: false});

test('.stopAndPersist() - isEnabled:false outputs text', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'all done'});
}, /- foo\n@ all done\n$/, {isEnabled: false});

test('.start() - isSilent:true no output', macro, spinner => {
	spinner.stop();
}, /^(?![\s\S])/, {isSilent: true});

test('.stopAndPersist() - isSilent:true no output', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'all done'});
}, /^(?![\s\S])/, {isSilent: true});

test('.stopAndPersist() - isSilent:true can be disabled', macro, spinner => {
	spinner.isSilent = false;
	spinner.stopAndPersist({symbol: '@', text: 'all done'});
}, /@ all done\n$/, {isSilent: true});

test('oraPromise() - resolves', async t => {
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

	t.regex(stripAnsi(await output), /[√✔] foo\n$/);
});

test('oraPromise() - rejects', async t => {
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

	t.regex(stripAnsi(await output), /[×✖] foo\n$/);
});

test('erases wrapped lines', t => {
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
	t.is(clearedLines, 0);
	t.is(cursorAtRow, 0);

	spinner.text = 'foo\n\nbar';
	spinner.render();
	t.is(clearedLines, 1); // Cleared 'foo'
	t.is(cursorAtRow, 0);

	spinner.render();
	t.is(clearedLines, 4); // Cleared 'foo\n\nbar'
	t.is(cursorAtRow, -2);

	spinner.clear();
	reset();
	spinner.text = '0'.repeat(stream.columns + 10);
	spinner.render();
	spinner.render();
	t.is(clearedLines, 2);
	t.is(cursorAtRow, -1);

	spinner.clear();
	reset();
	// Unicorns take up two cells, so this creates 3 rows of text not two
	spinner.text = '🦄'.repeat(stream.columns + 10);
	spinner.render();
	spinner.render();
	t.is(clearedLines, 3);
	t.is(cursorAtRow, -2);

	spinner.clear();
	reset();
	// Unicorns take up two cells. Remove the spinner and space and fill two rows,
	// then force a linebreak and write the third row.
	spinner.text = '🦄'.repeat(stream.columns - 2) + '\nfoo';
	spinner.render();
	spinner.render();
	t.is(clearedLines, 3);
	t.is(cursorAtRow, -2);

	spinner.clear();
	reset();
	spinner.prefixText = 'foo\n';
	spinner.text = '\nbar';
	spinner.render();
	spinner.render();
	t.is(clearedLines, 3); // Cleared 'foo\n\nbar'
	t.is(cursorAtRow, -2);

	spinner.clear();
	reset();
	spinner.prefixText = 'foo\n';
	spinner.text = '\nbar';
	spinner.suffixText = '\nbaz';
	spinner.render();
	spinner.render();
	t.is(clearedLines, 4); // Cleared 'foo\n\nbar \nbaz'
	t.is(cursorAtRow, -3);

	spinner.stop();
});

test('reset frameIndex when setting new spinner', async t => {
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

	t.is(spinner._frameIndex, -1);

	spinner.render();
	t.is(spinner._frameIndex, 0);

	spinner.spinner = {frames: ['baz']};
	spinner.render();

	stream.end();

	t.is(spinner._frameIndex, 0);
	t.regex(stripAnsi(await output), /foo baz/);
});

test('set the correct interval when changing spinner (object case)', t => {
	const spinner = ora({
		isEnabled: false,
		spinner: {frames: ['foo', 'bar']},
		interval: 300,
	});

	t.is(spinner.interval, 300);

	spinner.spinner = {frames: ['baz'], interval: 200};

	t.is(spinner.interval, 200);
});

test('set the correct interval when changing spinner (string case)', t => {
	const spinner = ora({
		isEnabled: false,
		spinner: 'dots',
		interval: 100,
	});

	t.is(spinner.interval, 100);

	spinner.spinner = 'layer';

	const expectedInterval = process.platform === 'win32' ? 130 : 150;
	t.is(spinner.interval, expectedInterval);
});

if (process.platform !== 'win32') {
	test('throw when incorrect spinner', t => {
		const spinner = ora();

		t.throws(() => {
			spinner.spinner = 'random-string-12345';
		}, {
			message: /no built-in spinner/,
		});
	});
}

test('throw when spinner is set to `default`', t => {
	t.throws(() => {
		ora({spinner: 'default'});
	}, {
		message: /no built-in spinner/,
	});
});

test('indent option', t => {
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

	spinner.render();
	spinner.clear();
	t.is(cursorAtRow, 7);
	spinner.stop();
});

test('indent option throws', t => {
	const stream = getPassThroughStream();

	const spinner = ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
	});

	t.throws(() => {
		spinner.indent = -1;
	}, {
		message: 'The `indent` option must be an integer from 0 and up',
	});
});

test('handles wrapped lines when length of indent + text is greater than columns', t => {
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

	t.is(spinner._lineCount, 2);
});

test('.stopAndPersist() with prefixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'foo'});
}, /bar @ foo\n$/, {prefixText: 'bar'});

test('.stopAndPersist() with empty prefixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'foo'});
}, /@ foo\n$/, {prefixText: ''});

test('.stopAndPersist() with manual prefixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', prefixText: 'baz', text: 'foo'});
}, /baz @ foo\n$/, {prefixText: 'bar'});

test('.stopAndPersist() with manual empty prefixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', prefixText: '', text: 'foo'});
}, /@ foo\n$/, {prefixText: 'bar'});

test('.stopAndPersist() with dynamic prefixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '&', prefixText: () => 'babeee', text: 'yorkie'});
}, /babeee & yorkie\n$/, {prefixText: () => 'babeee'});

test('.stopAndPersist() with suffixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'foo'});
}, /@ foo bar\n$/, {suffixText: 'bar'});

test('.stopAndPersist() with empty suffixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'foo'});
}, /@ foo\n$/, {suffixText: ''});

test('.stopAndPersist() with manual suffixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', suffixText: 'baz', text: 'foo'});
}, /@ foo baz\n$/, {suffixText: 'bar'});

test('.stopAndPersist() with manual empty suffixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', suffixText: '', text: 'foo'});
}, /@ foo\n$/, {suffixText: 'bar'});

test('.stopAndPersist() with dynamic suffixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '&', suffixText: () => 'babeee', text: 'yorkie'});
}, /& yorkie babeee\n$/, {suffixText: () => 'babeee'});

test('.stopAndPersist() with prefixText and suffixText', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'foo'});
}, /bar @ foo baz\n$/, {prefixText: 'bar', suffixText: 'baz'});

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

	let firstIndent = true;

	spinner.clear = function () {
		if (!this._isEnabled || !this._stream.isTTY) {
			return this;
		}

		for (let index = 0; index < this._linesToClear; index++) {
			if (index > 0) {
				this._stream.moveCursor(0, -1);
			}

			this._stream.clearLine();
			this._stream.cursorTo(this.indent);
		}

		// It's too quick to be noticeable, but indent does not get applied
		// for the first render if `linesToClear === 0`. The new clear method
		// doesn't have this issue, since it's called outside of the loop.
		if (this._linesToClear === 0 && firstIndent && this.indent) {
			this._stream.cursorTo(this.indent);
			firstIndent = false;
		}

		this._linesToClear = 0;

		return this;
	}.bind(spinner);

	return spinner;
};

test.serial('new clear method test, basic', t => {
	const transformTTY = new TransformTTY({crlf: true});
	transformTTY.addSequencer();
	transformTTY.addSequencer(null, true);

	/*
	If the frames from this sequence differ from the previous sequence,
	it means the `spinner.clear()` method has failed to fully clear output between calls to render.
	*/

	const currentClearTTY = new TransformTTY({crlf: true});
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

	t.is(sequenceString, '          ✔ boz?\n');
	t.is(sequenceString, clearedSequenceString);

	t.deepEqual(clearedFrames, ['- foo', '     - bar', '          - baz', '          ✔ boz?\n']);
	t.deepEqual(frames, clearedFrames);

	const currentString = currentClearTTY.getSequenceStrings();

	t.is(currentString, '          ✔ boz?\n');

	const currentFrames = currentClearTTY.getFrames();

	t.deepEqual(frames, currentFrames);
	// Frames created using new clear method are deep equal to frames created using current clear method
});

test('new clear method test, erases wrapped lines', t => {
	const transformTTY = new TransformTTY({crlf: true, columns: 40});
	transformTTY.addSequencer();
	transformTTY.addSequencer(null, true);

	const currentClearTTY = new TransformTTY({crlf: true, columns: 40});
	currentClearTTY.addSequencer();

	const currentOra = currentClearMethod(currentClearTTY);

	const cursorAtRow = () => {
		const cursor = transformTTY.getCursorPos();
		return cursor.y === 0 ? 0 : cursor.y * -1;
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
	t.is(clearedLines(), 1); // Cleared 'foo'
	t.is(cursorAtRow(), 0);

	currentOra.text = 'foo\n\nbar';
	currentOra.render();

	spinner.text = 'foo\n\nbar';
	spinner.render();
	t.is(clearedLines(), 3); // Cleared 'foo\n\nbar'
	t.is(cursorAtRow(), -2);

	currentOra.clear();
	currentOra.text = '0'.repeat(currentOra._stream.columns + 10);
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.text = '0'.repeat(spinner._stream.columns + 10);
	spinner.render();
	spinner.render();
	t.is(clearedLines(), 2);
	t.is(cursorAtRow(), -1);

	currentOra.clear();
	currentOra.text = '🦄'.repeat(currentOra._stream.columns + 10);
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.text = '🦄'.repeat(spinner._stream.columns + 10);
	spinner.render();
	spinner.render();
	t.is(clearedLines(), 3);
	t.is(cursorAtRow(), -2);

	currentOra.clear();
	currentOra.text = '🦄'.repeat(currentOra._stream.columns - 2) + '\nfoo';
	currentOra.render();
	currentOra.render();

	spinner.clear();
	spinner.text = '🦄'.repeat(spinner._stream.columns - 2) + '\nfoo';
	spinner.render();
	spinner.render();
	t.is(clearedLines(), 3);
	t.is(cursorAtRow(), -2);

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
	t.is(clearedLines(), 4); // Cleared 'foo\n\nbar \nbaz'
	t.is(cursorAtRow(), -3);

	const [sequenceString, clearedSequenceString] = transformTTY.getSequenceStrings();
	const [frames, clearedFrames] = transformTTY.getFrames();

	t.is(sequenceString, 'foo\n - \nbar \nbaz');
	t.is(sequenceString, clearedSequenceString);

	t.deepEqual(clearedFrames, [
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

	t.deepEqual(frames, clearedFrames);

	const currentClearString = currentClearTTY.toString();
	t.is(currentClearString, 'foo\n - \nbar \nbaz');

	const currentFrames = currentClearTTY.getFrames();
	t.deepEqual(frames, currentFrames);
});

test('should throw TypeError when a non-writable stream is passed', t => {
	const nonWritableStream = {};

	const error = t.throws(_ => ora({stream: nonWritableStream}), {
		instanceOf: TypeError,
	});

	t.is(error.message, 'Stream must be a writable stream');
});

test('new clear method, stress test', t => {
	const rando = (min, max) => {
		min = Math.ceil(min);
		max = Math.floor(max);
		return Math.floor(Math.random() * ((max - min) + min));
	};

	const rAnDoMaNiMaLs = (min, max) => {
		const length = rando(min, max);
		let result = '';
		const THEAMINALS = ['🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐙', '🐵', '🐦', '🐧', '🐔', '🐒', '🙉', '🙈', '🐣', '🐥', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', ...Array.from({length: 5}).fill('\n')];

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

	const transformTTY = new TransformTTY({crlf: true});
	transformTTY.addSequencer();
	transformTTY.addSequencer(null, true);

	const currentClearTTY = new TransformTTY({crlf: true});
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

			for (let x = 0; x < loops; x++) {
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

	t.deepEqual(frames, clearedFrames);

	t.deepEqual(frames.slice(0, currentFrames.length), currentFrames);

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
