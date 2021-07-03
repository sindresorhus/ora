import {expectType} from 'tsd';
import {PassThrough as PassThroughStream} from 'stream';
import ora = require('./index.js');
import {promise} from './index.js';

const spinner = ora('Loading unicorns');
ora({text: 'Loading unicorns'});
ora({prefixText: 'Loading unicorns'});
ora({prefixText: () => 'Loading unicorns dynamically'});
ora({spinner: 'squish'});
ora({spinner: {frames: ['-', '+', '-']}});
ora({spinner: {interval: 80, frames: ['-', '+', '-']}});
ora({color: 'cyan'});
ora({hideCursor: true});
ora({indent: 1});
ora({interval: 80});
ora({stream: new PassThroughStream()});
ora({isEnabled: true});
ora({isSilent: false});
ora({discardStdin: true});

spinner.color = 'yellow';
spinner.text = 'Loading rainbows';
expectType<boolean>(spinner.isSpinning);
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
spinner.clear();
spinner.render();
spinner.frame();

const resolves = Promise.resolve(1);
void promise(resolves, 'foo');
void promise(resolves, {
	stream: new PassThroughStream(),
	text: 'foo',
	color: 'blue',
	isEnabled: true,
	isSilent: false
});
void promise(async () => {
	await resolves;
}, 'foo');
void promise(async spinner => {
	spinner.prefixText = 'foo';
	await resolves;
	return 7;
}, {
	stream: new PassThroughStream(),
	text: 'foo',
	color: 'blue',
	isEnabled: true,
	isSilent: false,
	successText: result => `Resolved with number ${result}`,
	failText: 'bar'
});
