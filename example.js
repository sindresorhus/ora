import process from 'node:process';
import chalk from 'chalk';
import logSymbols from 'log-symbols';
import ora from './index.js';

const spinner = ora({
	discardStdin: false,
	text: 'Loading unicorns, not discarding stdin',
	spinner: process.argv[2],
});

const spinnerDiscardingStdin = ora({
	text: 'Loading unicorns',
	spinner: process.argv[2],
});

spinnerDiscardingStdin.start();

setTimeout(() => {
	spinnerDiscardingStdin.succeed();
}, 1000);

setTimeout(() => {
	spinnerDiscardingStdin.start();
}, 2000);

setTimeout(() => {
	spinnerDiscardingStdin.succeed();
	spinner.start();
}, 3000);

setTimeout(() => {
	spinner.color = 'yellow';
	spinner.text = `Loading ${chalk.red('rainbows')}`;
}, 4000);

setTimeout(() => {
	spinner.color = 'green';
	spinner.indent = 2;
	spinner.text = 'Loading with indent';
}, 5000);

setTimeout(() => {
	spinner.indent = 0;
	spinner.spinner = 'moon';
	spinner.text = 'Loading with different spinners';
}, 6000);

setTimeout(() => {
	spinner.prefixText = chalk.dim('[info]');
	spinner.spinner = 'dots';
	spinner.text = 'Loading with prefix text';
}, 8000);

setTimeout(() => {
	spinner.prefixText = '';
	spinner.suffixText = chalk.dim('[info]');
	spinner.text = 'Loading with suffix text';
}, 10_000);

setTimeout(() => {
	spinner.prefixText = chalk.dim('[info]');
	spinner.suffixText = chalk.dim('[info]');
	spinner.text = 'Loading with prefix and suffix text';
}, 12_000);

setTimeout(() => {
	spinner.stopAndPersist({
		prefixText: '',
		suffixText: '',
		symbol: logSymbols.info,
		text: 'Stopping with different text!',
	});
}, 14_000);

// $ node example.js nameOfSpinner
