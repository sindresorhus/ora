#!/usr/bin/env node
import process from 'node:process';
import chalk from 'chalk';
import ora from './index.js';

console.log(chalk.bold.cyan('\n📏 Terminal Height Overflow Test - Fixed Version 📏'));
console.log(chalk.gray('This demo shows the fix for issue #121 - multiline content exceeding terminal height.\n'));

// Get terminal dimensions
const rows = process.stderr.rows ?? 30;
const cols = process.stderr.columns ?? 80;

console.log(chalk.yellow(`Your terminal: ${rows} rows × ${cols} columns`));
console.log(chalk.green(`Creating spinner with ${rows + 10} lines (exceeds by 10 lines)\n`));

// Create content that exceeds terminal height
const lines = [];
for (let index = 1; index <= rows + 10; index++) {
	const emoji = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣'][index % 6];
	lines.push(`${emoji} Line ${String(index).padStart(3, '0')}: Processing item #${index}`);
}

const spinner = ora({
	text: lines.join('\n'),
	spinner: 'dots',
	color: 'cyan',
}).start();

// Update a few times
let updates = 0;
const interval = setInterval(() => {
	updates++;
	if (updates <= 3) {
		spinner.color = ['yellow', 'green', 'magenta'][updates - 1];
		spinner.text = `Update ${updates}/3\n${lines.join('\n')}`;
	} else {
		clearInterval(interval);
		spinner.succeed('Done! Content that exceeded terminal height has been properly cleared.');

		console.log('\n' + chalk.bold.green('✅ The Fix:'));
		console.log(chalk.white('When content exceeds terminal height, ora now:'));
		console.log(chalk.gray('  1. Detects the overflow (lines > terminal rows)'));
		console.log(chalk.gray('  2. Truncates content to fit terminal with message'));
		console.log(chalk.gray('  3. Prevents garbage lines from being written'));

		console.log('\n' + chalk.bold.yellow('🔍 Try scrolling up now!'));
		console.log(chalk.gray('You should NOT see leftover spinner frames above.'));
		console.log(chalk.gray('Content was truncated to prevent overflow.\n'));
	}
}, 1000);
