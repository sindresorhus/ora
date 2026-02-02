import { styleText } from 'node:util';
import ora from './index.js';

console.log(styleText('bold', '\n🦄 Unicorn Console Integration Demo\n'));
console.log(styleText('dim', 'This example shows how ora seamlessly handles console.error/warn'));
console.log(styleText('dim', 'while the spinner is running. These write to stderr where ora hooks!\n'));

// Simulate collecting unicorns with status updates
const collectUnicorns = ora({
	text: 'Searching for unicorns in the enchanted forest...',
	color: 'magenta',
}).start();

setTimeout(() => {
	console.error(styleText('cyan', '✨ Found a baby unicorn near the crystal stream!'));
}, 500);

setTimeout(() => {
	console.error(styleText('yellow', '✨ Spotted a golden unicorn on the rainbow bridge!'));
}, 1000);

setTimeout(() => {
	// mapped #FFA500 -> yellowBright
	console.warn(styleText('yellowBright', '⚠️  A wild unicorn is shy and hiding behind clouds'));
}, 1500);

setTimeout(() => {
	console.error(styleText('magenta', '✨ Discovered a unicorn herd in the meadow!'));
}, 2000);

setTimeout(() => {
	console.error(styleText('red', '❌ Dark forest area is too dangerous to explore'));
}, 2500);

setTimeout(() => {
	collectUnicorns.succeed(styleText(['bold', 'green'], 'Collected 3 magical unicorns! 🦄🦄🦄'));

	// Start processing unicorn magic
	const processSpinner = ora({
		text: 'Processing unicorn magic...',
		color: 'cyan',
	}).start();

	setTimeout(() => {
		console.error(styleText('blue', '🌟 Converting stardust to rainbow essence'));
	}, 500);

	setTimeout(() => {
		console.error(styleText('magenta', '🌈 Brewing magical unicorn potion'));
	}, 1000);

	setTimeout(() => {
		console.error(styleText('yellow', '✨ Enchanting unicorn horn fragments'));
	}, 1500);

	setTimeout(() => {
		processSpinner.succeed(styleText('green', 'Unicorn magic processed successfully!'));

		// Deploy unicorn powers
		const deploySpinner = ora({
			text: 'Deploying unicorn powers to the world...',
			color: 'magenta',
			spinner: 'dots12',
		}).start();

		setTimeout(() => {
			// mapped #FF1493 -> magentaBright
			console.error(styleText('magentaBright', '💫 Spreading joy and sparkles'));
		}, 400);

		setTimeout(() => {
			// mapped #9370DB -> magenta
			console.error(styleText('magenta', '🎨 Painting rainbows across the sky'));
		}, 800);

		setTimeout(() => {
			// mapped #FFD700 -> yellowBright
			console.error(styleText('yellowBright', '⭐ Granting wishes to believers'));
		}, 1200);

		setTimeout(() => {
			deploySpinner.succeed(styleText(['bold', 'green'], '🦄 Unicorn powers deployed! The world is more magical now! ✨'));

			// Summary (using console.log is fine here since spinner is stopped)
			console.log(styleText('dim', '\n' + '─'.repeat(60)));
			console.log(styleText(['bold', 'cyan'], '\n📊 Mission Summary:'));
			console.log(styleText('white', '  • Unicorns collected: ') + styleText('bold', '3'));
			console.log(styleText('white', '  • Magic spells cast: ') + styleText('bold', '6'));
			console.log(styleText('white', '  • Rainbows created: ') + styleText('bold', '∞'));
			console.log(styleText('white', '  • World happiness: ') + styleText(['bold', 'green'], '+1000%'));
			console.log(styleText('dim', '\n' + '─'.repeat(60)));

			console.log(styleText(['bold', 'magenta'], '\n✨ Notice how all console.error/warn appeared cleanly above the spinner!'));
			console.log(styleText('dim', 'The spinner automatically clears, shows your message, then re-renders below.'));
			console.log(styleText('dim', 'Both console.log() and console.error/warn() work seamlessly while spinning! 🎉\n'));
		}, 1600);
	}, 2000);
}, 3000);
