import process from 'node:process';
import {stripVTControlCharacters} from 'node:util';
import chalk from 'chalk';
import cliCursor from 'cli-cursor';
import cliSpinners from 'cli-spinners';
import logSymbols from 'log-symbols';
import stringWidth from 'string-width';
import isInteractive from 'is-interactive';
import isUnicodeSupported from 'is-unicode-supported';
import stdinDiscarder from 'stdin-discarder';

// Constants
const RENDER_DEFERRAL_TIMEOUT = 200; // Milliseconds to wait before re-rendering after partial chunk write
const SYNCHRONIZED_OUTPUT_ENABLE = '\u001B[?2026h';
const SYNCHRONIZED_OUTPUT_DISABLE = '\u001B[?2026l';

// Global state for concurrent spinner detection
const activeHooksPerStream = new Map(); // Stream → ora instance

class Ora {
	#linesToClear = 0;
	#frameIndex = -1;
	#lastFrameTime = 0;
	#options;
	#spinner;
	#stream;
	#id;
	#hookedStreams = new Map();
	#isInternalWrite = false;
	#drainHandler;
	#deferRenderTimer;
	#isDiscardingStdin = false;
	color;

	// Helper to execute writes while preventing hook recursion
	#internalWrite(fn) {
		this.#isInternalWrite = true;
		try {
			return fn();
		} finally {
			this.#isInternalWrite = false;
		}
	}

	// Helper to render if still spinning
	#tryRender() {
		if (this.isSpinning) {
			this.render();
		}
	}

	#stringifyChunk(chunk, encoding) {
		if (chunk === undefined || chunk === null) {
			return '';
		}

		if (typeof chunk === 'string') {
			return chunk;
		}

		/* eslint-disable n/prefer-global/buffer */
		if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) {
			const normalizedEncoding = (typeof encoding === 'string' && encoding && encoding !== 'buffer') ? encoding : 'utf8';
			return Buffer.from(chunk).toString(normalizedEncoding);
		}
		/* eslint-enable n/prefer-global/buffer */

		return String(chunk);
	}

	#chunkTerminatesLine(chunkString) {
		if (!chunkString) {
			return false;
		}

		const lastCharacter = chunkString.at(-1);
		return lastCharacter === '\n' || lastCharacter === '\r';
	}

	#scheduleRenderDeferral() {
		// If already deferred, don't reset timer - let it complete
		if (this.#deferRenderTimer) {
			return;
		}

		this.#deferRenderTimer = setTimeout(() => {
			this.#deferRenderTimer = undefined;

			if (this.isSpinning) {
				this.#tryRender();
			}
		}, RENDER_DEFERRAL_TIMEOUT);

		if (typeof this.#deferRenderTimer?.unref === 'function') {
			this.#deferRenderTimer.unref();
		}
	}

	#clearRenderDeferral() {
		if (this.#deferRenderTimer) {
			clearTimeout(this.#deferRenderTimer);
			this.#deferRenderTimer = undefined;
		}
	}

	// Helper to build complete line with symbol, text, prefix, and suffix
	#buildOutputLine(symbol, text, prefixText, suffixText) {
		const fullPrefixText = this.#getFullPrefixText(prefixText, ' ');
		const separatorText = symbol ? ' ' : '';
		const fullText = (typeof text === 'string') ? separatorText + text : '';
		const fullSuffixText = this.#getFullSuffixText(suffixText, ' ');
		return fullPrefixText + symbol + fullText + fullSuffixText;
	}

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

		this.#stream = this.#options.stream;

		// Normalize isEnabled and isSilent into options
		if (typeof this.#options.isEnabled !== 'boolean') {
			this.#options.isEnabled = isInteractive({stream: this.#stream});
		}

		if (typeof this.#options.isSilent !== 'boolean') {
			this.#options.isSilent = false;
		}

		// Set *after* `this.#stream`.
		// Store original interval before spinner setter clears it
		const userInterval = this.#options.interval;
		// It's important that these use the public setters.
		this.spinner = this.#options.spinner;
		this.#options.interval = userInterval;
		this.text = this.#options.text;
		this.prefixText = this.#options.prefixText;
		this.suffixText = this.#options.suffixText;
		this.indent = this.#options.indent;

		if (process.env.NODE_ENV === 'test') {
			this._stream = this.#stream;
			this._isEnabled = this.#options.isEnabled;

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
					const columns = this.#stream.columns ?? 80;
					const prefixText = typeof this.#options.prefixText === 'function' ? '' : this.#options.prefixText;
					const suffixText = typeof this.#options.suffixText === 'function' ? '' : this.#options.suffixText;
					const fullPrefixText = (typeof prefixText === 'string' && prefixText !== '') ? prefixText + ' ' : '';
					const fullSuffixText = (typeof suffixText === 'string' && suffixText !== '') ? ' ' + suffixText : '';
					const spinnerChar = '-';
					const fullText = ' '.repeat(this.#options.indent) + fullPrefixText + spinnerChar + (typeof this.#options.text === 'string' ? ' ' + this.#options.text : '') + fullSuffixText;
					return this.#computeLineCountFrom(fullText, columns);
				},
			});
		}
	}

	get indent() {
		return this.#options.indent;
	}

	set indent(indent = 0) {
		if (!(indent >= 0 && Number.isInteger(indent))) {
			throw new Error('The `indent` option must be an integer from 0 and up');
		}

		this.#options.indent = indent;
	}

	get interval() {
		return this.#options.interval ?? this.#spinner.interval ?? 100;
	}

	get spinner() {
		return this.#spinner;
	}

	set spinner(spinner) {
		this.#frameIndex = -1;
		this.#options.interval = undefined;

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
		return this.#options.text;
	}

	set text(value = '') {
		this.#options.text = value;
	}

	get prefixText() {
		return this.#options.prefixText;
	}

	set prefixText(value = '') {
		this.#options.prefixText = value;
	}

	get suffixText() {
		return this.#options.suffixText;
	}

	set suffixText(value = '') {
		this.#options.suffixText = value;
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

	#getFullPrefixText(prefixText = this.#options.prefixText, postfix = ' ') {
		return this.#formatAffix(prefixText, postfix, false);
	}

	#getFullSuffixText(suffixText = this.#options.suffixText, prefix = ' ') {
		return this.#formatAffix(suffixText, prefix, true);
	}

	#computeLineCountFrom(text, columns) {
		let count = 0;
		for (const line of stripVTControlCharacters(text).split('\n')) {
			count += Math.max(1, Math.ceil(stringWidth(line) / columns));
		}

		return count;
	}

	get isEnabled() {
		return this.#options.isEnabled && !this.#options.isSilent;
	}

	set isEnabled(value) {
		if (typeof value !== 'boolean') {
			throw new TypeError('The `isEnabled` option must be a boolean');
		}

		this.#options.isEnabled = value;
	}

	get isSilent() {
		return this.#options.isSilent;
	}

	set isSilent(value) {
		if (typeof value !== 'boolean') {
			throw new TypeError('The `isSilent` option must be a boolean');
		}

		this.#options.isSilent = value;
	}

	frame() {
		// Only advance frame if enough time has passed (throttle to interval)
		const now = Date.now();
		if (this.#frameIndex === -1 || now - this.#lastFrameTime >= this.interval) {
			this.#frameIndex = (this.#frameIndex + 1) % this.#spinner.frames.length;
			this.#lastFrameTime = now;
		}

		const {frames} = this.#spinner;
		let frame = frames[this.#frameIndex];

		if (this.color) {
			frame = chalk[this.color](frame);
		}

		const fullPrefixText = this.#getFullPrefixText(this.#options.prefixText, ' ');
		const fullText = typeof this.text === 'string' ? ' ' + this.text : '';
		const fullSuffixText = this.#getFullSuffixText(this.#options.suffixText, ' ');

		return fullPrefixText + frame + fullText + fullSuffixText;
	}

	clear() {
		if (!this.isEnabled || !this.#stream.isTTY) {
			return this;
		}

		// Protect cursor control methods (cursorTo, moveCursor, clearLine) which internally call stream.write
		this.#internalWrite(() => {
			this.#stream.cursorTo(0);

			for (let index = 0; index < this.#linesToClear; index++) {
				if (index > 0) {
					this.#stream.moveCursor(0, -1);
				}

				this.#stream.clearLine(1);
			}

			if (this.#options.indent) {
				this.#stream.cursorTo(this.#options.indent);
			}
		});

		this.#linesToClear = 0;

		return this;
	}

	// Helper to hook a single stream
	#hookStream(stream) {
		if (!stream || this.#hookedStreams.has(stream) || !stream.isTTY || typeof stream.write !== 'function') {
			return;
		}

		// Detect concurrent spinners
		if (activeHooksPerStream.has(stream)) {
			console.warn('[ora] Multiple concurrent spinners detected. This may cause visual corruption. Use one spinner at a time.');
		}

		const originalWrite = stream.write;
		this.#hookedStreams.set(stream, originalWrite);
		activeHooksPerStream.set(stream, this);
		stream.write = (chunk, encoding, callback) => this.#hookedWrite(stream, originalWrite, chunk, encoding, callback);
	}

	/**
	Intercept stream writes while spinner is active to handle external writes cleanly without visual corruption.
	Hooks process stdio streams and the active spinner stream so console.log(), console.error(), and direct writes stay tidy.
	*/
	#installHook() {
		if (!this.isEnabled || this.#hookedStreams.size > 0) {
			return;
		}

		const streamsToHook = new Set([this.#stream, process.stdout, process.stderr]);

		for (const stream of streamsToHook) {
			this.#hookStream(stream);
		}
	}

	#uninstallHook() {
		for (const [stream, originalWrite] of this.#hookedStreams) {
			stream.write = originalWrite;
			if (activeHooksPerStream.get(stream) === this) {
				activeHooksPerStream.delete(stream);
			}
		}

		this.#hookedStreams.clear();
	}

	// eslint-disable-next-line max-params -- Need stream and originalWrite for multi-stream support
	#hookedWrite(stream, originalWrite, chunk, encoding, callback) {
		// Handle both write(chunk, encoding, callback) and write(chunk, callback) signatures
		if (typeof encoding === 'function') {
			callback = encoding;
			encoding = undefined;
		}

		// Pass through our own internal writes (spinner rendering, cursor control)
		if (this.#isInternalWrite) {
			return originalWrite.call(stream, chunk, encoding, callback);
		}

		// External write detected - clear spinner, write content, re-render if appropriate
		this.clear();

		const chunkString = this.#stringifyChunk(chunk, encoding);
		const chunkTerminatesLine = this.#chunkTerminatesLine(chunkString);

		const writeResult = originalWrite.call(stream, chunk, encoding, callback);

		// Schedule or clear render deferral based on chunk content
		if (chunkTerminatesLine) {
			this.#clearRenderDeferral();
		} else if (chunkString.length > 0) {
			this.#scheduleRenderDeferral();
		}

		// Re-render spinner below the new output if still spinning and not deferred
		if (this.isSpinning && !this.#deferRenderTimer) {
			this.render();
		}

		return writeResult;
	}

	render() {
		if (!this.isEnabled || this.#drainHandler || this.#deferRenderTimer) {
			return this;
		}

		const useSynchronizedOutput = this.#stream.isTTY;
		let shouldDisableSynchronizedOutput = false;

		try {
			if (useSynchronizedOutput) {
				this.#internalWrite(() => this.#stream.write(SYNCHRONIZED_OUTPUT_ENABLE));
				shouldDisableSynchronizedOutput = true;
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

			const canContinue = this.#internalWrite(() => this.#stream.write(frameContent));

			// Handle backpressure - pause rendering if stream buffer is full
			if (canContinue === false && this.#stream.isTTY) {
				this.#drainHandler = () => {
					this.#drainHandler = undefined;
					this.#tryRender();
				};

				this.#stream.once('drain', this.#drainHandler);
			}

			this.#linesToClear = this.#computeLineCountFrom(frameContent, columns);
		} finally {
			if (shouldDisableSynchronizedOutput) {
				this.#internalWrite(() => this.#stream.write(SYNCHRONIZED_OUTPUT_DISABLE));
			}
		}

		return this;
	}

	start(text) {
		if (text) {
			this.text = text;
		}

		if (this.isSilent) {
			return this;
		}

		if (!this.isEnabled) {
			const symbol = this.text ? '-' : '';
			const line = ' '.repeat(this.#options.indent) + this.#buildOutputLine(symbol, this.text, this.#options.prefixText, this.#options.suffixText);

			if (line.trim() !== '') {
				this.#internalWrite(() => this.#stream.write(line + '\n'));
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
			stdinDiscarder.start();
			this.#isDiscardingStdin = true;
		}

		this.#installHook();
		this.render();
		this.#id = setInterval(this.render.bind(this), this.interval);

		return this;
	}

	stop() {
		clearInterval(this.#id);
		this.#id = undefined;
		this.#frameIndex = -1;
		this.#lastFrameTime = 0;

		this.#clearRenderDeferral();
		this.#uninstallHook();

		// Clean up drain handler if it exists
		if (this.#drainHandler) {
			this.#stream.removeListener('drain', this.#drainHandler);
			this.#drainHandler = undefined;
		}

		if (this.isEnabled) {
			this.clear();
			if (this.#options.hideCursor) {
				cliCursor.show(this.#stream);
			}
		}

		if (this.#isDiscardingStdin) {
			this.#isDiscardingStdin = false;
			stdinDiscarder.stop();
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
		if (this.isSilent) {
			return this;
		}

		const symbol = options.symbol ?? ' ';
		const text = options.text ?? this.text;
		const prefixText = options.prefixText ?? this.#options.prefixText;
		const suffixText = options.suffixText ?? this.#options.suffixText;

		const textToWrite = this.#buildOutputLine(symbol, text, prefixText, suffixText) + '\n';

		this.stop();
		this.#internalWrite(() => this.#stream.write(textToWrite));

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
