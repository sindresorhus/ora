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
// Rendering waits for a newline when external output leaves its line unfinished.
const SYNCHRONIZED_OUTPUT_ENABLE = '\u{1B}[?2026h';
const SYNCHRONIZED_OUTPUT_DISABLE = '\u{1B}[?2026l';
const TRUNCATION_MESSAGE = '... (content truncated to fit terminal)';
const STYLE_RESET = '\u{1B}[0m';
const TAB_STOP = 8; // Terminals advance a tab to the next multiple of this

// Grapheme clusters, so that emoji and combining marks are measured the way a terminal measures them
const segmenter = new Intl.Segmenter();

// The segmenter joins a carriage return and a line feed into one grapheme, so they are split out first
const controlCharacter = /(?<control>[\t\n\r])/v;

// eslint-disable-next-line regexp/no-obscure-range -- the range is exactly printable ASCII
const printableAscii = /^[ -~]+$/v;

// The cells a tab covers from the given column, stopping on the last cell of the row
const tabStopWidth = (column, columns) => {
	const nextStop = (Math.floor(column / TAB_STOP) * TAB_STOP) + TAB_STOP;
	return Math.max(0, Math.min(nextStop, columns - 1) - column);
};

/*
Lay out text the way a terminal shows it. Returns its rows, and the text with tabs expanded and escape sequences removed, to lay out again after a resize.

A line feed starts a new row at its start, because a terminal device writes it as a carriage return and a line feed, even in raw mode. A carriage return goes back to the start of the row without erasing it. A row only ends when a grapheme no longer fits.
*/
const layOut = (text, columns) => {
	const rows = [];
	let cells;
	let column;
	let expandedText = '';

	const startRow = () => {
		cells = [];
		column = 0;
		rows.push(cells);
	};

	const writeGrapheme = (grapheme, width) => {
		// A grapheme without width, such as a bell, takes no cell
		if (width === 0) {
			return;
		}

		if (column + width > columns) {
			startRow();
		}

		// A wide grapheme also covers the cells after it
		cells[column++] = grapheme;
		for (let index = 1; index < width; index++) {
			cells[column++] = '';
		}
	};

	// A tab moves the cursor without erasing what it passes over
	const writeTab = () => {
		const end = column + tabStopWidth(column, columns);
		expandedText += ' '.repeat(end - column);
		for (; column < end; column++) {
			cells[column] ??= ' ';
		}
	};

	startRow();

	for (const part of stripVTControlCharacters(text).split(controlCharacter)) {
		if (part === '\t') {
			writeTab();
			continue;
		}

		expandedText += part;

		if (part === '\n') {
			startRow();
		} else if (part === '\r') {
			column = 0;
		} else if (printableAscii.test(part)) {
			// Printable ASCII is one cell per character, so it skips the segmenter
			for (const character of part) {
				writeGrapheme(character, 1);
			}
		} else {
			for (const {segment} of segmenter.segment(part)) {
				writeGrapheme(segment, stringWidth(segment));
			}
		}
	}

	return {rows, expandedText};
};

const rowCount = (text, columns) => layOut(text, columns).rows.length;

const formatAffix = (value, separator, isPlaceBefore) => {
	const resolved = typeof value === 'function' ? value() : value;
	if (typeof resolved === 'string' && resolved !== '') {
		return isPlaceBefore ? (separator + resolved) : (resolved + separator);
	}

	return '';
};

// Global state for concurrent spinner detection
const activeHooksPerStream = new Map(); // Stream → ora instance
const originalWritesPerStream = new Map(); // Stream → the real `write` before any spinner hooked it

const validColors = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray']);

class Ora {
	#linesToClear = 0;
	#frameIndex = -1;
	#lastFrameTime = 0;
	#renderedFrame;
	#renderedColumns;
	#options;
	#spinner;
	#stream;
	#id;
	#hookedStreams = new Set();
	#isInternalWrite = false;
	#drainHandler;
	#hasUnfinishedLine = false;
	#isDiscardingStdin = false;
	#color;

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

		// Spreading options over the defaults can set `stream` to `undefined`
		this.#stream = this.#options.stream ?? process.stderr;

		// Normalize isEnabled and isSilent into options
		if (typeof this.#options.isEnabled !== 'boolean') {
			this.#options.isEnabled = isInteractive({stream: this.#stream});
		}

		if (typeof this.#options.isSilent !== 'boolean') {
			this.#options.isSilent = false;
		}

		if (this.#options.interval !== undefined && !(Number.isSafeInteger(this.#options.interval) && this.#options.interval > 0)) {
			throw new Error('The `interval` option must be a positive integer');
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

		if (process.env.NODE_ENV !== 'test') {
			return;
		}

		this._stream = this.#stream;
		this._isEnabled = this.#options.isEnabled;

		Object.defineProperties(this, {
			_linesToClear: {
				get() {
					return this.#linesToClear;
				},
				set(newValue) {
					this.#linesToClear = newValue;
				},
			},
			_frameIndex: {
				get() {
					return this.#frameIndex;
				},
			},
			_renderedFrame: {
				get() {
					return this.#renderedFrame;
				},
			},
			_renderedColumns: {
				get() {
					return this.#renderedColumns;
				},
			},
			_lineCount: {
				get() {
					// The line `frame()` builds, without calling a function affix, so reading this has no side effect
					const {prefixText, suffixText} = this.#options;
					const line = this.#buildOutputLine(
						'-',
						this.#options.text,
						typeof prefixText === 'function' ? '' : prefixText,
						typeof suffixText === 'function' ? '' : suffixText,
					);
					const fullText = ' '.repeat(this.#options.indent) + line;
					return rowCount(fullText, this.#columns);
				},
			},
		});
	}

	// Helper to execute writes while preventing hook recursion
	#internalWrite(fn) {
		this.#isInternalWrite = true;
		try {
			return fn();
		} finally {
			this.#isInternalWrite = false;
		}
	}

	/*
	Helper to render if still spinning. A timer or drain render has no caller to handle an error, such as a throwing `prefixText` function or a broken stream, and the render after an external write must not throw at the program's own write, so the spinner stops itself instead. The frame stays counted for `stop()` to erase.
	*/
	#tryRender() {
		if (!this.isSpinning) {
			return;
		}

		try {
			this.render();
		} catch {
			this.#release();
			this.#showCursor();
		}
	}

	// The stream may be what failed, so showing the cursor is best effort
	#showCursor() {
		if (!this.#options.hideCursor) {
			return;
		}

		try {
			cliCursor.show(this.#stream);
		} catch {}
	}

	#stringifyChunk(chunk, encoding) {
		if (chunk === undefined || chunk === null) {
			return '';
		}

		if (typeof chunk === 'string') {
			return chunk;
		}

		/* eslint-disable n/prefer-global/buffer -- the global Buffer is the class the stream hands over */
		if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) {
			const normalizedEncoding = (typeof encoding === 'string' && encoding && encoding !== 'buffer') ? encoding : 'utf8';
			return Buffer.from(chunk).toString(normalizedEncoding);
		}
		/* eslint-enable n/prefer-global/buffer -- see above */

		return String(chunk);
	}

	// Deferral lasts until a newline, without a timeout; unfinished lines are neither erased nor retained for replay.
	// Give back the timer, the stream hooks and stdin, without writing to the stream, which may have failed
	#release() {
		clearInterval(this.#id);
		this.#id = undefined;
		this.#frameIndex = -1;
		this.#lastFrameTime = 0;

		this.#uninstallHook();

		// Clean up drain handler if it exists
		if (this.#drainHandler) {
			this.#stream.removeListener('drain', this.#drainHandler);
			this.#drainHandler = undefined;
		}

		// The unfinished-line state belongs to this run, so a later run starts fresh
		this.#hasUnfinishedLine = false;

		if (!this.#isDiscardingStdin) {
			return;
		}

		this.#isDiscardingStdin = false;
		stdinDiscarder.stop();
	}

	// Helper to build complete line with symbol, text, prefix, and suffix
	#buildOutputLine(symbol, text, prefixText, suffixText) {
		// Each part is only separated from what comes before it when there is something there, so nothing leaves a double space
		const hasSymbol = symbol !== '';
		const hasText = typeof text === 'string' && text !== '';
		const fullPrefixText = formatAffix(prefixText, (hasSymbol || hasText) ? ' ' : '', false);
		const separatorText = hasSymbol ? ' ' : '';
		const fullText = (typeof text === 'string') ? separatorText + text : '';
		// An empty text still gets the separator after the symbol, so the suffix does not add another
		const doesBodyEndWithSeparator = hasSymbol && text === '';
		const fullSuffixText = formatAffix(suffixText, doesBodyEndWithSeparator ? '' : ' ', true);
		return fullPrefixText + symbol + fullText + fullSuffixText;
	}

	#startRenderTimer() {
		clearInterval(this.#id);
		this.#id = setInterval(this.#tryRender.bind(this), this.interval);
	}

	// A terminal can report `0` columns, for example while its window is minimized, which would put every character on a row of its own
	get #columns() {
		return this.#stream.columns || 80;
	}

	get #canMoveCursor() {
		return Boolean(this.#stream.isTTY)
			&& typeof this.#stream.cursorTo === 'function'
			&& typeof this.#stream.moveCursor === 'function'
			&& typeof this.#stream.clearLine === 'function';
	}

	// Erase the frame that is currently on screen, if the stream can move the cursor
	#clearDisplay() {
		if (!this.#canMoveCursor || this.#linesToClear === 0) {
			return;
		}

		// Reflow varies by terminal, so resizing must never increase the recorded erase count and risk clearing preceding output
		const columns = this.#columns;
		if (this.#renderedFrame !== undefined && this.#renderedColumns !== columns) {
			this.#linesToClear = Math.min(this.#linesToClear, rowCount(this.#renderedFrame, columns));
		}

		// Protect cursor control methods (cursorTo, moveCursor, clearLine) which internally call stream.write
		try {
			this.#eraseRows(this.#linesToClear);
		} finally {
			// Forget the frame even if the erase failed, so a later call does not retry the same rows
			this.#linesToClear = 0;
			this.#renderedFrame = undefined;
		}
	}

	// Erase the given number of rows, ending on the row the cursor is on
	#eraseRows(count) {
		this.#internalWrite(() => {
			this.#stream.cursorTo(0);

			for (let index = 0; index < count; index++) {
				if (index > 0) {
					this.#stream.moveCursor(0, -1);
				}

				this.#stream.clearLine(1);
			}
		});
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

		// Concurrent spinners are unsupported, but the real `write` is restored whichever one stops last
		if (!originalWritesPerStream.has(stream)) {
			originalWritesPerStream.set(stream, stream.write);
		}

		const originalWrite = stream.write;
		this.#hookedStreams.add(stream);
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
		for (const stream of this.#hookedStreams) {
			if (activeHooksPerStream.get(stream) === this) {
				activeHooksPerStream.delete(stream);
			}

			// Another spinner may still be running, in which case its hook has to stay in place
			if (activeHooksPerStream.has(stream)) {
				continue;
			}

			const originalWrite = originalWritesPerStream.get(stream);
			if (originalWrite === undefined) {
				continue;
			}

			stream.write = originalWrite;
			originalWritesPerStream.delete(stream);
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

		// External write detected - erase the frame, write content, re-render if appropriate
		this.#clearDisplay();

		// Ignore styling codes when checking for a completed line; a carriage return does not finish it
		// Decode only to detect the newline. Replaying decoded chunks would corrupt UTF-8 characters split across buffer writes.
		const chunkString = stripVTControlCharacters(this.#stringifyChunk(chunk, encoding));
		if (chunkString !== '') {
			this.#hasUnfinishedLine = !chunkString.endsWith('\n');
		}

		const writeResult = originalWrite.call(stream, chunk, encoding, callback);

		// Re-render below completed output if still spinning. The write already went through, so a failed render stops the spinner instead of throwing at the program's own write.
		this.#tryRender();

		return writeResult;
	}

	get indent() {
		return this.#options.indent;
	}

	set indent(indent = 0) {
		if (!(indent >= 0 && Number.isSafeInteger(indent))) {
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
		// `typeof null === 'object'`, so it has to be excluded here to reach the built-in name check
		if (typeof spinner === 'object' && spinner !== null) {
			if (!Array.isArray(spinner.frames) || spinner.frames.length === 0 || spinner.frames.some(frame => typeof frame !== 'string')) {
				throw new Error('The given spinner must have a non-empty `frames` array of strings');
			}

			if (spinner.interval !== undefined && !(Number.isSafeInteger(spinner.interval) && spinner.interval > 0)) {
				throw new Error('`spinner.interval` must be a positive integer if provided');
			}

			this.#spinner = spinner;
		} else if (spinner !== undefined && (spinner === 'default' || !Object.hasOwn(cliSpinners, spinner))) {
			// The name is checked before the terminal is, so a wrong name throws on every terminal
			throw new Error(`There is no built-in spinner named '${spinner}'. See https://github.com/sindresorhus/cli-spinners/blob/main/spinners.json for a full list.`);
		} else if (isUnicodeSupported()) {
			// Set the named spinner, or the default one
			this.#spinner = cliSpinners[spinner ?? 'dots'];
		} else {
			this.#spinner = cliSpinners.line;
		}

		// Only touch the state once the new spinner is known to be valid
		this.#frameIndex = -1;
		this.#options.interval = undefined;

		// The render interval comes from the spinner, so the timer has to pick up the new one
		if (!this.isSpinning) {
			return;
		}

		this.#startRenderTimer();
		// The new interval can be long, so don't wait for the first tick to show it
		this.render();
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

	get color() {
		return this.#color;
	}

	set color(value) {
		if (value !== undefined && value !== false && !validColors.has(value)) {
			throw new Error('The `color` option must be a valid color or `false` to disable');
		}

		this.#color = value;
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

		if (this.#color) {
			frame = chalk[this.#color](frame);
		}

		const line = this.#buildOutputLine(frame, this.text, this.#options.prefixText, this.#options.suffixText);

		return ' '.repeat(this.#options.indent) + line;
	}

	clear() {
		if (!this.isEnabled) {
			return this;
		}

		this.#clearDisplay();

		return this;
	}

	/*
	A stream without the readline cursor methods, such as a CI log stream that reports a TTY, gets the frame written where the cursor is. External writes are only kept out of the frame while the spinner runs, since that is when the streams are hooked.
	*/
	render() {
		// Leave unfinished external output untouched until a newline, including after a resize
		// Do not add a timeout or reclaim the line: resized rows cannot be counted reliably, and replay would duplicate rows already in scrollback.
		if (!this.isEnabled || this.#drainHandler || this.#hasUnfinishedLine) {
			return this;
		}

		// Build the frame before writing anything, so a throwing `prefixText` or `suffixText` function leaves the screen as it was
		let frameContent = this.frame();
		const useSynchronizedOutput = this.#stream.isTTY;
		let shouldDisableSynchronizedOutput = false;

		try {
			if (useSynchronizedOutput) {
				this.#internalWrite(() => this.#stream.write(SYNCHRONIZED_OUTPUT_ENABLE));
				shouldDisableSynchronizedOutput = true;
			}

			// Erasing the previous frame leaves the cursor at the start of a row, otherwise it is moved there
			if (this.#linesToClear > 0) {
				this.#clearDisplay();
			} else if (this.#canMoveCursor) {
				this.#internalWrite(() => this.#stream.cursorTo(0));
			}

			const columns = this.#columns;
			let layout = layOut(frameContent, columns);

			// If content would exceed viewport height, truncate it to prevent garbage
			/*
			The frame stays above the last row, because a frame that scrolls cannot be erased. A terminal cannot report its cursor row, so this bounds the frame by the screen, and earlier output can still scroll into the scrollback.
			*/
			const maxRows = this.#stream.rows > 1 ? this.#stream.rows - 1 : undefined;
			if (layout.rows.length > maxRows) {
				// The message replaces the last rows, and is shortened until it fits
				let message = TRUNCATION_MESSAGE;
				while (message.length > 1 && rowCount(message, columns) > maxRows) {
					message = message.slice(0, -1);
				}

				// Whole lines are kept as they are, so they keep their colors. The line that does not fit is cut to the rows that are left, and that part is plain.
				let rowBudget = maxRows - rowCount(message, columns);
				const keptLines = [];
				for (const line of frameContent.split('\n')) {
					const lineRows = layOut(line, columns).rows;
					if (lineRows.length > rowBudget) {
						keptLines.push(...lineRows.slice(0, rowBudget).map(cells => cells.join('')));
						break;
					}

					keptLines.push(line);
					rowBudget -= lineRows.length;
				}

				// A style that a dropped line would have closed must not color the message
				frameContent = [...keptLines, STYLE_RESET + message].join('\n');
				layout = layOut(frameContent, columns);
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

			this.#linesToClear = layout.rows.length;
			this.#renderedFrame = layout.expandedText;
			this.#renderedColumns = columns;
		} finally {
			if (shouldDisableSynchronizedOutput) {
				this.#internalWrite(() => this.#stream.write(SYNCHRONIZED_OUTPUT_DISABLE));
			}
		}

		return this;
	}

	start(text) {
		if (text !== undefined) {
			this.text = text;
		}

		// A call while spinning or silent only updates the text, even if output was disabled while spinning
		if (this.isSpinning || this.isSilent) {
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

		if (this.#options.hideCursor) {
			cliCursor.hide(this.#stream);
		}

		if (this.#options.discardStdin && process.stdin.isTTY) {
			stdinDiscarder.start();
			this.#isDiscardingStdin = true;
		}

		this.#installHook();

		try {
			this.render();
		} catch (error) {
			// Undo the hooks, stdin and the hidden cursor before the error reaches the caller
			this.#release();
			this.#showCursor();
			throw error;
		}

		this.#startRenderTimer();

		return this;
	}

	stop() {
		// Use the state from `start()`, as `isEnabled` and `isSilent` can change while spinning
		const wasSpinning = this.isSpinning;

		this.#release();

		// Erase the frame as best effort since the stream may have failed
		try {
			this.#clearDisplay();
		} catch {}

		if (wasSpinning) {
			this.#showCursor();
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

	stopAndPersist(options) {
		// Start on a new row instead of continuing an unfinished external line
		const hasUnfinishedLine = this.#hasUnfinishedLine;
		this.stop();

		if (this.isSilent) {
			return this;
		}

		// `options` is optional, so `null` has to behave like `undefined`
		const symbolText = String(options?.symbol ?? ' ');
		// The `log-symbols` colors are resolved for stdout, so they are stripped when this stream cannot render color
		const renderedSymbol = (this.isEnabled && this.#stream.isTTY) ? symbolText : stripVTControlCharacters(symbolText);
		const text = options?.text ?? this.text;
		const prefixText = options?.prefixText ?? this.#options.prefixText;
		const suffixText = options?.suffixText ?? this.#options.suffixText;

		// The indent is part of the content, so the cursor is left at the start of the line
		const textToWrite = (hasUnfinishedLine ? '\n' : '') + ' '.repeat(this.#options.indent) + this.#buildOutputLine(renderedSymbol, text, prefixText, suffixText) + '\n';

		this.#internalWrite(() => this.#stream.write(textToWrite));

		return this;
	}
}

export default function ora(options) {
	return new Ora(options);
}

export async function oraPromise(action, options) {
	const isActionFunction = typeof action === 'function';
	const isActionPromise = typeof action?.then === 'function';

	if (!isActionFunction && !isActionPromise) {
		throw new TypeError('Parameter `action` must be a Function or a Promise');
	}

	const {
		successText,
		failText,
		successSymbol,
		failSymbol,
	} = options ?? {};

	const spinner = ora(options).start();
	const resolveText = (value, argument) => typeof value === 'function' ? value(argument) : value;

	let result;
	try {
		result = await (isActionFunction ? action(spinner) : action);
	} catch (error) {
		let text;
		try {
			text = resolveText(failText, error);
		} catch {
			// The original error is more useful to the caller than the one from `failText`
		}

		try {
			spinner.stopAndPersist({symbol: failSymbol ?? logSymbols.error, text});
		} catch {
			// The original error is more useful to the caller than a stream error from the persist
		}

		throw error;
	}

	// Resolve `successText` outside the `try` above, so that a throw is not reported as a failure
	let text;
	try {
		text = resolveText(successText, result);
	} catch (error) {
		spinner.stop();
		throw error;
	}

	try {
		spinner.stopAndPersist({symbol: successSymbol ?? logSymbols.success, text});
	} catch {
		// The action already succeeded, so a stream error from the persist must not discard the result
	}

	return result;
}

export {default as spinners} from 'cli-spinners';
