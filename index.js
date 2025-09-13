import process from 'node:process';
import chalk from 'chalk';
import cliCursor from 'cli-cursor';
import cliSpinners from 'cli-spinners';
import logSymbols from 'log-symbols';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import isInteractive from 'is-interactive';
import isUnicodeSupported from 'is-unicode-supported';
import stdinDiscarder from 'stdin-discarder';

class Ora {
	#linesToClear = 0;
	#isDiscardingStdin = false;
	#lineCount = 0;
	#frameIndex = -1;
	#lastSpinnerFrameTime = 0;
	#lastIndent = 0;
	#options;
	#spinner;
	#stream;
	#id;
	#initialInterval;
	#isEnabled;
	#isSilent;
	#indent;
	#text;
	#prefixText;
	#suffixText;
	color;

	constructor(options) {
		if (typeof options === 'string') {
			options = {
				text: options,
			};
		}

		this.#options = {
			color: 'cyan',
			stream: process.stderr,
			discardStdin: true,
			hideCursor: true,
			...options,
		};

		// Public
		this.color = this.#options.color;

		// It's important that these use the public setters.
		this.spinner = this.#options.spinner;

		this.#initialInterval = this.#options.interval;
		this.#stream = this.#options.stream;
		this.#isEnabled = typeof this.#options.isEnabled === 'boolean' ? this.#options.isEnabled : isInteractive({stream: this.#stream});
		this.#isSilent = typeof this.#options.isSilent === 'boolean' ? this.#options.isSilent : false;

		// Set *after* `this.#stream`.
		// It's important that these use the public setters.
		this.text = this.#options.text;
		this.prefixText = this.#options.prefixText;
		this.suffixText = this.#options.suffixText;
		this.indent = this.#options.indent;

		if (process.env.NODE_ENV === 'test') {
			this._stream = this.#stream;
			this._isEnabled = this.#isEnabled;

			Object.defineProperty(this, '_linesToClear', {
				get() {
					return this.#linesToClear;
				},
				set(newValue) {
					this.#linesToClear = newValue;
				},
			});

			Object.defineProperty(this, '_frameIndex', {
				get() {
					return this.#frameIndex;
				},
			});

			Object.defineProperty(this, '_lineCount', {
				get() {
					return this.#lineCount;
				},
			});
		}
	}

	get indent() {
		return this.#indent;
	}

	set indent(indent = 0) {
		if (!(indent >= 0 && Number.isInteger(indent))) {
			throw new Error('The `indent` option must be an integer from 0 and up');
		}

		this.#indent = indent;
		this.#updateLineCount();
	}

	get interval() {
		return this.#initialInterval ?? this.#spinner.interval ?? 100;
	}

	get spinner() {
		return this.#spinner;
	}

	set spinner(spinner) {
		this.#frameIndex = -1;
		this.#initialInterval = undefined;

		if (typeof spinner === 'object') {
			if (!Array.isArray(spinner.frames) || spinner.frames.length === 0 || spinner.frames.some(frame => typeof frame !== 'string')) {
				throw new Error('The given spinner must have a non-empty `frames` array of strings');
			}

			if (spinner.interval !== undefined && !(Number.isInteger(spinner.interval) && spinner.interval > 0)) {
				throw new Error('`spinner.interval` must be a positive integer if provided');
			}

			this.#spinner = spinner;
		} else if (!isUnicodeSupported()) {
			this.#spinner = cliSpinners.line;
		} else if (spinner === undefined) {
			// Set default spinner
			this.#spinner = cliSpinners.dots;
		} else if (spinner !== 'default' && cliSpinners[spinner]) {
			this.#spinner = cliSpinners[spinner];
		} else {
			throw new Error(`There is no built-in spinner named '${spinner}'. See https://github.com/sindresorhus/cli-spinners/blob/main/spinners.json for a full list.`);
		}
	}

	get text() {
		return this.#text;
	}

	set text(value = '') {
		this.#text = value;
		this.#updateLineCount();
	}

	get prefixText() {
		return this.#prefixText;
	}

	set prefixText(value = '') {
		this.#prefixText = value;
		this.#updateLineCount();
	}

	get suffixText() {
		return this.#suffixText;
	}

	set suffixText(value = '') {
		this.#suffixText = value;
		this.#updateLineCount();
	}

	get isSpinning() {
		return this.#id !== undefined;
	}

	#formatAffix(value, separator, placeBefore = false) {
		const resolved = typeof value === 'function' ? value() : value;
		if (typeof resolved === 'string' && resolved !== '') {
			return placeBefore ? (separator + resolved) : (resolved + separator);
		}

		return '';
	}

	#getFullPrefixText(prefixText = this.#prefixText, postfix = ' ') {
		return this.#formatAffix(prefixText, postfix, false);
	}

	#getFullSuffixText(suffixText = this.#suffixText, prefix = ' ') {
		return this.#formatAffix(suffixText, prefix, true);
	}

	#computeLineCountFrom(text, columns) {
		let count = 0;
		for (const line of stripAnsi(text).split('\n')) {
			count += Math.max(1, Math.ceil(stringWidth(line) / columns));
		}

		return count;
	}

	#updateLineCount() {
		const columns = this.#stream.columns ?? 80;

		// Simple side-effect free approximation (do not call functions)
		const prefixText = typeof this.#prefixText === 'function' ? '' : this.#prefixText;
		const suffixText = typeof this.#suffixText === 'function' ? '' : this.#suffixText;
		const fullPrefixText = (typeof prefixText === 'string' && prefixText !== '') ? prefixText + ' ' : '';
		const fullSuffixText = (typeof suffixText === 'string' && suffixText !== '') ? ' ' + suffixText : '';
		const spinnerChar = '-';
		const fullText = ' '.repeat(this.#indent) + fullPrefixText + spinnerChar + (typeof this.#text === 'string' ? ' ' + this.#text : '') + fullSuffixText;

		this.#lineCount = this.#computeLineCountFrom(fullText, columns);
	}

	get isEnabled() {
		return this.#isEnabled && !this.#isSilent;
	}

	set isEnabled(value) {
		if (typeof value !== 'boolean') {
			throw new TypeError('The `isEnabled` option must be a boolean');
		}

		this.#isEnabled = value;
	}

	get isSilent() {
		return this.#isSilent;
	}

	set isSilent(value) {
		if (typeof value !== 'boolean') {
			throw new TypeError('The `isSilent` option must be a boolean');
		}

		this.#isSilent = value;
	}

	frame() {
		// Ensure we only update the spinner frame at the wanted interval,
		// even if the render method is called more often.
		const now = Date.now();
		if (this.#frameIndex === -1 || now - this.#lastSpinnerFrameTime >= this.interval) {
			this.#frameIndex = ++this.#frameIndex % this.#spinner.frames.length;
			this.#lastSpinnerFrameTime = now;
		}

		const {frames} = this.#spinner;
		let frame = frames[this.#frameIndex];

		if (this.color) {
			frame = chalk[this.color](frame);
		}

		const fullPrefixText = this.#getFullPrefixText(this.#prefixText, ' ');
		const fullText = typeof this.text === 'string' ? ' ' + this.text : '';
		const fullSuffixText = this.#getFullSuffixText(this.#suffixText, ' ');

		return fullPrefixText + frame + fullText + fullSuffixText;
	}

	clear() {
		if (!this.#isEnabled || !this.#stream.isTTY) {
			return this;
		}

		this.#stream.cursorTo(0);

		for (let index = 0; index < this.#linesToClear; index++) {
			if (index > 0) {
				this.#stream.moveCursor(0, -1);
			}

			this.#stream.clearLine(1);
		}

		if (this.#indent || this.#lastIndent !== this.#indent) {
			this.#stream.cursorTo(this.#indent);
		}

		this.#lastIndent = this.#indent;
		this.#linesToClear = 0;

		return this;
	}

	render() {
		if (!this.#isEnabled || this.#isSilent) {
			return this;
		}

		this.clear();

		let frameContent = this.frame();
		const columns = this.#stream.columns ?? 80;
		const actualLineCount = this.#computeLineCountFrom(frameContent, columns);

		// If content would exceed viewport height, truncate it to prevent garbage
		const consoleHeight = this.#stream.rows;
		if (consoleHeight && consoleHeight > 1 && actualLineCount > consoleHeight) {
			const lines = frameContent.split('\n');
			const maxLines = consoleHeight - 1; // Reserve one line for truncation message
			frameContent = [...lines.slice(0, maxLines), '... (content truncated to fit terminal)'].join('\n');
		}

		this.#stream.write(frameContent);
		this.#linesToClear = this.#computeLineCountFrom(frameContent, columns);

		return this;
	}

	start(text) {
		if (text) {
			this.text = text;
		}

		if (this.#isSilent) {
			return this;
		}

		if (!this.#isEnabled) {
			const line = ' '.repeat(this.#indent) + this.#getFullPrefixText(this.#prefixText, ' ') + (this.text ? `- ${this.text}` : '') + this.#getFullSuffixText(this.#suffixText, ' ');

			if (line.trim() !== '') {
				this.#stream.write(line + '\n');
			}

			return this;
		}

		if (this.isSpinning) {
			return this;
		}

		if (this.#options.hideCursor) {
			cliCursor.hide(this.#stream);
		}

		if (this.#options.discardStdin && process.stdin.isTTY) {
			this.#isDiscardingStdin = true;
			stdinDiscarder.start();
		}

		this.render();
		this.#id = setInterval(this.render.bind(this), this.interval);

		return this;
	}

	stop() {
		clearInterval(this.#id);
		this.#id = undefined;
		this.#frameIndex = 0;

		if (this.#isEnabled) {
			this.clear();
			if (this.#options.hideCursor) {
				cliCursor.show(this.#stream);
			}
		}

		if (this.#options.discardStdin && process.stdin.isTTY && this.#isDiscardingStdin) {
			stdinDiscarder.stop();
			this.#isDiscardingStdin = false;
		}

		return this;
	}

	succeed(text) {
		return this.stopAndPersist({symbol: logSymbols.success, text});
	}

	fail(text) {
		return this.stopAndPersist({symbol: logSymbols.error, text});
	}

	warn(text) {
		return this.stopAndPersist({symbol: logSymbols.warning, text});
	}

	info(text) {
		return this.stopAndPersist({symbol: logSymbols.info, text});
	}

	stopAndPersist(options = {}) {
		if (this.#isSilent) {
			return this;
		}

		const prefixText = options.prefixText ?? this.#prefixText;
		const fullPrefixText = this.#getFullPrefixText(prefixText, ' ');

		const symbolText = options.symbol ?? ' ';

		const text = options.text ?? this.text;
		const separatorText = symbolText ? ' ' : '';
		const fullText = (typeof text === 'string') ? separatorText + text : '';

		const suffixText = options.suffixText ?? this.#suffixText;
		const fullSuffixText = this.#getFullSuffixText(suffixText, ' ');

		const textToWrite = fullPrefixText + symbolText + fullText + fullSuffixText + '\n';

		this.stop();
		this.#stream.write(textToWrite);

		return this;
	}
}

export default function ora(options) {
	return new Ora(options);
}

export async function oraPromise(action, options) {
	const actionIsFunction = typeof action === 'function';
	const actionIsPromise = typeof action.then === 'function';

	if (!actionIsFunction && !actionIsPromise) {
		throw new TypeError('Parameter `action` must be a Function or a Promise');
	}

	const {successText, failText} = typeof options === 'object'
		? options
		: {successText: undefined, failText: undefined};

	const spinner = ora(options).start();

	try {
		const promise = actionIsFunction ? action(spinner) : action;
		const result = await promise;

		spinner.succeed(successText === undefined
			? undefined
			: (typeof successText === 'string' ? successText : successText(result)));

		return result;
	} catch (error) {
		spinner.fail(failText === undefined
			? undefined
			: (typeof failText === 'string' ? failText : failText(error)));

		throw error;
	}
}

export {default as spinners} from 'cli-spinners';
