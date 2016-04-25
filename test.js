import test from 'ava';
import hookStd from 'hook-std';
import Ora from './';

function readOutput(spinner, callback) {
	let out = '';

	const unhook = hookStd.stderr({silent: true}, output => {
		out += output;
	});

	spinner.start();
	spinner.stop();
	unhook();

	callback(out);
}

test.before(() => {
	// TODO: use the the `stream` option instead of hooking stderr

	process.stderr.isTTY = true;
	process.stderr.clearLine = function () {};
	process.stderr.cursorTo = function () {};
});

test('main', t => {
	t.plan(1);

	const spinner = new Ora({text: 'foo', color: false});

	spinner.enabled = true;

	readOutput(spinner, (output) => {
		let expectedOutput = process.platform === 'win32' ? '- foo' : '⠋ foo';
		t.is(output, expectedOutput);
	});
});

test('title shortcut', t => {
	t.plan(1);

	const ora = Ora;
	const spinner = ora('foo');

	spinner.color = false;
	spinner.enabled = true;

	readOutput(spinner, (output) => {
		let expectedOutput = process.platform === 'win32' ? '- foo' : '⠋ foo';
		t.is(output, expectedOutput);
	});
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
