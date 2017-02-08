import {PassThrough as PassThroughStream} from 'stream';
import getStream from 'get-stream';
import test from 'ava';
import {stripColor} from 'chalk';
import Ora from '.';

const spinnerChar = process.platform === 'win32' ? '-' : '⠋';
const noop = () => {};

const getPassThroughStream = () => {
	const stream = new PassThroughStream();
	stream.clearLine = noop;
	stream.cursorTo = noop;
	return stream;
};

test('main', async t => {
	t.plan(1);

	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.stop();

	stream.end();
	const output = await getStream(stream);

	t.is(output, `${spinnerChar} foo`);
});

test('title shortcut', async t => {
	t.plan(1);

	const stream = getPassThroughStream();
	const ora = Ora;
	const spinner = ora('foo');
	spinner.stream = stream;

	spinner.color = false;
	spinner.enabled = true;

	spinner.start();
	spinner.stop();

	stream.end();
	const output = await getStream(stream);

	t.is(output, `${spinnerChar} foo`);
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

test('succeed', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.succeed();

	stream.end();
	const output = await getStream(stream);

	t.regex(stripColor(output), /(✔|√) foo/);
});

test('succeed with new text', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.succeed('fooed');

	stream.end();
	const output = await getStream(stream);

	t.regex(stripColor(output), /(✔|√) fooed/);
});

test('warn', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.warn();

	stream.end();
	const output = await getStream(stream);

	t.regex(stripColor(output), /⚠ foo/);
});

test('warn with new text', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.warn('fooed');

	stream.end();
	const output = await getStream(stream);

	t.regex(stripColor(output), /⚠ fooed/);
});

test('fail', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.fail();

	stream.end();
	const output = await getStream(stream);

	t.regex(stripColor(output), /(✖|×) foo/);
});

test('fail with new text', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.fail('failed to foo');

	stream.end();
	const output = await getStream(stream);

	t.regex(stripColor(output), /(✖|×) failed to foo/);
});

test('stopAndPersist', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.stopAndPersist('@');

	stream.end();
	const output = await getStream(stream);

	t.regex(output, /@ foo/);
});

test('stopAndPersist with no argument', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.stopAndPersist(' ');

	stream.end();
	const output = await getStream(stream);

	t.regex(output, /\s foo/);
});

test('stopAndPersist with new text', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.stopAndPersist({text: 'all done'});

	stream.end();
	const output = await getStream(stream);

	t.regex(output, /\s all done/);
});

test('stopAndPersist with new symbol and text', async t => {
	const stream = getPassThroughStream();

	const spinner = new Ora({
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	spinner.start();
	spinner.stopAndPersist({symbol: '@', text: 'all done'});

	stream.end();
	const output = await getStream(stream);

	t.regex(output, /@ all done/);
});

test('promise resolves', async t => {
	const stream = getPassThroughStream();
	const resolves = Promise.resolve(1);

	Ora.promise(resolves, {
		stream,
		text: 'foo',
		color: false,
		enabled: true
	});

	await resolves;

	stream.end();
	const output = await getStream(stream);

	t.regex(output, /(✔|√) foo/);
});

test('promise rejects', async t => {
	const stream = getPassThroughStream();
	const rejects = Promise.reject(1);

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
	const output = await getStream(stream);
	t.regex(output, /(✖|×) foo/);
});
