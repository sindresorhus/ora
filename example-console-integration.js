import chalk from 'chalk';
import ora from './index.js';

console.log(chalk.bold('\n🦄 Unicorn Console Integration Demo\n'));
console.log(chalk.dim('This example shows how ora seamlessly handles console.error/warn'));
console.log(chalk.dim('while the spinner is running. These write to stderr where ora hooks!\n'));

// Simulate collecting unicorns with status updates
const collectUnicorns = ora({
	text: 'Searching for unicorns in the enchanted forest...',
	color: 'magenta',
}).start();

setTimeout(() => {
	console.error(chalk.cyan('✨ Found a baby unicorn near the crystal stream!'));
}, 500);

setTimeout(() => {
	console.error(chalk.yellow('✨ Spotted a golden unicorn on the rainbow bridge!'));
}, 1000);

setTimeout(() => {
	console.warn(chalk.hex('#FFA500')('⚠️  A wild unicorn is shy and hiding behind clouds'));
}, 1500);

setTimeout(() => {
	console.error(chalk.magenta('✨ Discovered a unicorn herd in the meadow!'));
}, 2000);

setTimeout(() => {
	console.error(chalk.red('❌ Dark forest area is too dangerous to explore'));
}, 2500);

setTimeout(() => {
	collectUnicorns.succeed(chalk.green('Collected 3 magical unicorns! 🦄🦄🦄'));

	// Start processing unicorn magic
	const processSpinner = ora({
		text: 'Processing unicorn magic...',
		color: 'cyan',
	}).start();

	setTimeout(() => {
		console.error(chalk.blue('🌟 Converting stardust to rainbow essence'));
	}, 500);

	setTimeout(() => {
		console.error(chalk.magenta('🌈 Brewing magical unicorn potion'));
	}, 1000);

	setTimeout(() => {
		console.error(chalk.yellow('✨ Enchanting unicorn horn fragments'));
	}, 1500);

	setTimeout(() => {
		processSpinner.succeed(chalk.green('Unicorn magic processed successfully!'));

		// Deploy unicorn powers
		const deploySpinner = ora({
			text: 'Deploying unicorn powers to the world...',
			color: 'magenta',
			spinner: 'dots12',
		}).start();

		setTimeout(() => {
			console.error(chalk.hex('#FF1493')('💫 Spreading joy and sparkles'));
		}, 400);

		setTimeout(() => {
			console.error(chalk.hex('#9370DB')('🎨 Painting rainbows across the sky'));
		}, 800);

		setTimeout(() => {
			console.error(chalk.hex('#FFD700')('⭐ Granting wishes to believers'));
		}, 1200);

		setTimeout(() => {
			deploySpinner.succeed(chalk.bold.green('🦄 Unicorn powers deployed! The world is more magical now! ✨'));

			// Summary (using console.log is fine here since spinner is stopped)
			console.log(chalk.dim('\n' + '─'.repeat(60)));
			console.log(chalk.bold.cyan('\n📊 Mission Summary:'));
			console.log(chalk.white('  • Unicorns collected: ') + chalk.bold('3'));
			console.log(chalk.white('  • Magic spells cast: ') + chalk.bold('6'));
			console.log(chalk.white('  • Rainbows created: ') + chalk.bold('∞'));
			console.log(chalk.white('  • World happiness: ') + chalk.bold.green('+1000%'));
			console.log(chalk.dim('\n' + '─'.repeat(60)));

			console.log(chalk.bold.magenta('\n✨ Notice how all console.error/warn appeared cleanly above the spinner!'));
			console.log(chalk.dim('The spinner automatically clears, shows your message, then re-renders below.'));
			console.log(chalk.dim('Both console.log() and console.error/warn() work seamlessly while spinning! 🎉\n'));
		}, 1600);
	}, 2000);
}, 3000);
