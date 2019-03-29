import {expectType} from 'tsd-check';
import {PassThrough as PassThroughStream} from 'stream';
import ora, {promise} from '.';

const spinner = ora('Loading unicorns');
ora({text: 'Loading unicorns'});
ora({prefixText: 'Loading unicorns'});
ora({spinner: 'squish'});
ora({spinner: {frames: ['-', '+', '-']}});
ora({spinner: {interval: 80, frames: ['-', '+', '-']}});
ora({color: 'cyan'});
ora({hideCursor: true});
ora({indent: 1});
ora({interval: 80});
ora({stream: new PassThroughStream()});
ora({isEnabled: true});

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
promise(resolves, 'foo');
promise(resolves, {
	stream: new PassThroughStream(),
	text: 'foo',
	color: 'blue',
	isEnabled: true
});
