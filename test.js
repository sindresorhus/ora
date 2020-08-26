import {PassThrough as PassThroughStream} from 'stream';
import getStream from 'get-stream';
import test from 'ava';
import stripAnsi from 'strip-ansi';
import Ora from '.';

const spinnerChar = process.platform === 'win32' ? '-' : '⠋';
const noop = () => {};

const getPassThroughStream = () => {
	const stream = new PassThroughStream();
	stream.clearLine = noop;
	stream.cursorTo = noop;
	stream.moveCursor = noop;
	return stream;
};

const doSpinner = async (fn, extraOptions = {}) => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		...extraOptions
	});

	spinner.start();
	fn(spinner);
	stream.end();

	return stripAnsi(await output);
};

const macro = async (t, fn, expected, extraOptions = {}) => {
	t.regex(await doSpinner(fn, extraOptions), expected);
};

test('main', macro, spinner => {
	spinner.stop();
}, new RegExp(`${spinnerChar} foo`));

test('title shortcut', async t => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const ora = Ora;

	const spinner = ora('foo');
	spinner.stream = stream;
	spinner.color = false;
	spinner.isEnabled = true;
	spinner.start();
	t.true(spinner.isSpinning);
	spinner.stop();

	stream.end();

	t.is(await output, `${spinnerChar} foo`);
});

test('`.id` is not set when created', t => {
	const spinner = new Ora('foo');
	t.falsy(spinner.id);
	t.false(spinner.isSpinning);
});

test('ignore consecutive calls to `.start()`', t => {
	const spinner = new Ora('foo');
	spinner.start();
	const {id} = spinner;
	spinner.start();
	t.is(id, spinner.id);
});

test('chain call to `.start()` with constructor', t => {
	const spinner = new Ora({
		stream: getPassThroughStream(),
		text: 'foo',
		isEnabled: true
	}).start();

	t.truthy(spinner.id);
	t.true(spinner.isEnabled);
});

test('.succeed()', macro, spinner => {
	spinner.succeed();
}, /(?:✔|√) foo\n$/);

test('.succeed() - with new text', macro, spinner => {
	spinner.succeed('fooed');
}, /(?:✔|√) fooed\n$/);

test('.fail()', macro, spinner => {
	spinner.fail();
}, /(?:✖|×) foo\n$/);

test('.fail() - with new text', macro, spinner => {
	spinner.fail('failed to foo');
}, /(?:✖|×) failed to foo\n$/);

test('.warn()', macro, spinner => {
	spinner.warn();
}, /(?:⚠|‼) foo\n$/);

test('.info()', macro, spinner => {
	spinner.info();
}, /(?:ℹ|i) foo\n$/);

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

test('.promise() - resolves', async t => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const resolves = Promise.resolve(1);

	Ora.promise(resolves, {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true
	});

	await resolves;
	stream.end();

	t.regex(stripAnsi(await output), /(?:✔|√) foo\n$/);
});

test('.promise() - rejects', async t => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const rejects = Promise.reject(new Error());

	Ora.promise(rejects, {
		stream,
		text: 'foo',
		color: false,
		isEnabled: true
	});

	try {
		await rejects;
	} catch (_) {}

	stream.end();

	t.regex(stripAnsi(await output), /(?:✖|×) foo\n$/);
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

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true
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

	spinner.stop();
});

test('reset frameIndex when setting new spinner', async t => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = new Ora({
		stream,
		isEnabled: true,
		spinner: {frames: ['foo', 'fooo']}
	});

	spinner.render();
	t.is(spinner.frameIndex, 1);

	spinner.spinner = {frames: ['baz']};
	spinner.render();

	stream.end();

	t.is(spinner.frameIndex, 0);
	t.regex(stripAnsi(await output), /foo baz/);
});

test('set the correct interval when changing spinner (object case)', t => {
	const spinner = new Ora({
		isEnabled: false,
		spinner: {frames: ['foo', 'bar']},
		interval: 300
	});

	t.is(spinner.interval, 300);

	spinner.spinner = {frames: ['baz'], interval: 200};

	t.is(spinner.interval, 200);
});

test('set the correct interval when changing spinner (string case)', t => {
	const spinner = new Ora({
		isEnabled: false,
		spinner: 'dots',
		interval: 100
	});

	t.is(spinner.interval, 100);

	spinner.spinner = 'layer';

	t.is(spinner.interval, 150);
});

test('throw when incorrect spinner', t => {
	const ora = new Ora();

	t.throws(() => {
		ora.spinner = 'random-string-12345';
	}, /no built-in spinner/);
});

test('indent option', t => {
	const stream = getPassThroughStream();
	stream.isTTY = true;
	let cursorAtRow = 0;
	stream.cursorTo = indent => {
		cursorAtRow = indent;
	};

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true,
		indent: 7
	});

	spinner.render();
	spinner.clear();
	t.is(cursorAtRow, 7);
	spinner.stop();
});

test('indent option throws', t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		isEnabled: true
	});

	t.throws(() => {
		spinner.indent = -1;
	}, 'The `indent` option must be an integer from 0 and up');
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
