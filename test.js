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

test('id is not set when created', t => {
	const spinner = new Ora({text: 'foo', color: false});
	t.notOk(spinner.id);
});

test('ignore consecutive calls to `start`', t => {
	const spinner = new Ora({text: 'foo', color: false});
	spinner.start();
	const id = spinner.id;
	spinner.start();
	t.same(id, spinner.id);
});

test(t => {
	t.plan(1);

	const spinner = new Ora({text: 'foo', color: false});

	spinner.enabled = true;

	readOutput(spinner, (output) => {
		t.is(output, '⠋ foo');
	});
});

test(t => {
	t.plan(1);

	const ora = Ora;
	const spinner = ora('foo');

	spinner.color = false;
	spinner.enabled = true;

	readOutput(spinner, (output) => {
		t.is(output, '⠋ foo');
	});
});
