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
	return stream;
};

const doSpinner = async fn => {
	const stream = getPassThroughStream();
	const output = getStream(stream);

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	fn(spinner);
	stream.end();

	return stripAnsi(await output);
};

const macro = async (t, fn, expected) => {
	t.regex(await doSpinner(fn), expected);
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
	spinner.enabled = true;
	spinner.start();
	spinner.stop();

	stream.end();

	t.is(await output, `${spinnerChar} foo`);
});

test('`.id` is not set when created', t => {
	const spinner = new Ora('foo');
	t.falsy(spinner.id);
});

test('ignore consecutive calls to `.start()`', t => {
	const spinner = new Ora('foo');
	spinner.start();
	const id = spinner.id;
	spinner.start();
	t.is(id, spinner.id);
});

test('chain call to `.start()` with constructor', t => {
	const spinner = new Ora({
		stream: getPassThroughStream(),
		text: 'foo',
		enabled: true
	}).start();

	t.truthy(spinner.id);
	t.true(spinner.enabled);
});

test('.succeed()', macro, spinner => {
	spinner.succeed();
}, /(✔|√) foo/);

test('.succeed() - with new text', macro, spinner => {
	spinner.succeed('fooed');
}, /(✔|√) fooed/);

test('.fail()', macro, spinner => {
	spinner.fail();
}, /(✖|×) foo/);

test('.fail() - with new text', macro, spinner => {
	spinner.fail('failed to foo');
}, /(✖|×) failed to foo/);

test('.warn()', macro, spinner => {
	spinner.warn();
}, /(⚠|‼) foo/);

test('.info()', macro, spinner => {
	spinner.info();
}, /(ℹ|i) foo/);

test('.stopAndPersist()', macro, spinner => {
	spinner.stopAndPersist('@');
}, /@ foo/);

test('.stopAndPersist() - with no argument', macro, spinner => {
	spinner.stopAndPersist(' ');
}, /\s foo/);

test('.stopAndPersist() - with new text', macro, spinner => {
	spinner.stopAndPersist({text: 'all done'});
}, /\s all done/);

test('.stopAndPersist() - with new symbol and text', macro, spinner => {
	spinner.stopAndPersist({symbol: '@', text: 'all done'});
}, /@ all done/);

test('spinner with default indent (0)', t => {
	const spinner = new Ora('foo');
	t.falsy(spinner.indent);
});

test('spinner with indent (7)', t => {
	const spinner = new Ora({
		text: 'bar',
		indent: 7,
		enabled: true
	});
	t.truthy(spinner.indent);
});

test('.promise() - resolves', async t => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const resolves = Promise.resolve(1);

	Ora.promise(resolves, {
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	await resolves;
	stream.end();

	t.regex(stripAnsi(await output), /(✔|√) foo/);
});

test('.promise() - rejects', async t => {
	const stream = getPassThroughStream();
	const output = getStream(stream);
	const rejects = Promise.reject(new Error());

	Ora.promise(rejects, {
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	try {
		await rejects;
	} catch (err) {}

	stream.end();

	t.regex(stripAnsi(await output), /(✖|×) foo/);
});
