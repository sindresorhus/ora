import {PassThrough as PassThroughStream} from 'node:stream';
import {expectError, expectType} from 'tsd';
import type cliSpinners from 'cli-spinners';
import ora, {oraPromise, spinners} from './index.js';

const spinner = ora('Loading unicorns');
ora({text: 'Loading unicorns'});
ora({prefixText: 'Loading unicorns'});
ora({prefixText: () => 'Loading unicorns dynamically'});
ora({suffixText: 'Loading unicorns'});
ora({suffixText: () => 'Loading unicorns dynamically'});
ora({spinner: 'squish'});
ora({spinner: {frames: ['-', '+', '-']}});
ora({spinner: {interval: 80, frames: ['-', '+', '-']}});
ora({color: 'cyan'});
ora({color: false});
ora({color: undefined});
expectError(ora({color: true}));
ora({hideCursor: true});
ora({indent: 1});
ora({interval: 80});
/// ora({stream: new PassThroughStream()});
ora({isEnabled: true});
ora({isSilent: false});
ora({discardStdin: true});

spinner.color = 'yellow';
spinner.color = false;
spinner.color = undefined;
expectError(spinner.color = true);
spinner.text = 'Loading rainbows';
spinner.prefixText = 'Loading';
spinner.prefixText = () => 'Loading dynamically';
spinner.suffixText = '[loading]';
spinner.suffixText = () => '[loading dynamically]';
expectType<boolean>(spinner.isSpinning);
expectType<boolean>(spinner.isEnabled);
spinner.isEnabled = false;
spinner.isEnabled = true;
expectType<boolean>(spinner.isSilent);
spinner.isSilent = true;
spinner.isSilent = false;
spinner.spinner = 'dots';
spinner.indent = 5;

spinner.start();
spinner.start('Test text');
spinner.stop();
spinner.succeed();
spinner.succeed('fooed');
spinner.fail();
spinner.fail('failed to foo');
spinner.warn();
spinner.warn('warn foo');
spinner.info();
spinner.info('info foo');
spinner.stopAndPersist();
spinner.stopAndPersist({text: 'all done'});
spinner.stopAndPersist({symbol: '@', text: 'all done'});
spinner.stopAndPersist({prefixText: 'all done'});
spinner.stopAndPersist({suffixText: 'all done'});
spinner.clear();
spinner.render();
spinner.frame();

const resolves = Promise.resolve(1);
void oraPromise(resolves, 'foo');
void oraPromise(resolves, {
	stream: new PassThroughStream(),
	text: 'foo',
	color: 'blue',
	isEnabled: true,
	isSilent: false,
});
void oraPromise(async () => {
	await resolves;
}, 'foo');
void oraPromise(async spinner => {
	spinner.prefixText = 'foo';
	spinner.suffixText = '[loading]';
	await resolves;
	return 7;
}, {
	stream: new PassThroughStream(),
	text: 'foo',
	color: 'blue',
	isEnabled: true,
	isSilent: false,
	successText: result => `Resolved with number ${result}`,
	failText: 'bar',
});
void oraPromise(Promise.reject(new Error('Failure')), {
	failText(error) {
		expectType<unknown>(error);
		return error instanceof Error ? error.message : String(error);
	},
});

expectType<typeof cliSpinners>(spinners);
