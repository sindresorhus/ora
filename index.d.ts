/// <reference types="node"/>
import {Writable as WritableStream} from 'stream';
import {SpinnerName} from 'cli-spinners';

export type Spinner = Readonly<{
	interval?: number;
	frames: string[];
}>;

export type Color =
	| 'black'
	| 'red'
	| 'green'
	| 'yellow'
	| 'blue'
	| 'magenta'
	| 'cyan'
	| 'white'
	| 'gray';

export type Options = Readonly<{
	/**
	 * Text to display after the spinner.
	 */
	text?: string;

	/**
	 * Text to display before the spinner.
	 */
	prefixText?: string;

	/**
	 * Name of one of the provided spinners. See [`example.js`](https://github.com/BendingBender/ora/blob/master/example.js) in this repo if you want to test out different spinners. On Windows, it will always use the line spinner as the Windows command-line doesn't have proper Unicode support.
	 *
	 * @default 'dots'
	 *
	 * Or an object like:
	 *
	 * @example
	 *
	 * {
	 * 	interval: 80, // Optional
	 * 	frames: ['-', '+', '-']
	 * }
	 *
	 */
	spinner?: SpinnerName | Spinner;

	/**
	 * Color of the spinner.
	 *
	 * @default 'cyan'
	 */
	color?: Color;

	/**
	 * Set to `false` to stop Ora from hiding the cursor.
	 *
	 * @default true
	 */
	hideCursor?: boolean;

	/**
	 * Indent the spinner with the given number of spaces.
	 *
	 * @default 0
	 */
	indent?: number;

	/**
	 * Interval between each frame.
	 *
	 * Spinners provide their own recommended interval, so you don't really need to specify this. Default value: Provided by the spinner or `100`.
	 */
	interval?: number;

	/**
	 * Stream to write the output.
	 *
	 * You could for example set this to `process.stdout` instead.
	 *
	 * @default process.stderr
	 */
	stream?: WritableStream;

	/**
	 * Force enable/disable the spinner. If not specified, the spinner will be enabled if the `stream` is being run inside a TTY context (not spawned or piped) and/or not in a CI environment.
	 *
	 * Note that `{isEnabled: false}` doesn't mean it won't output anything. It just means it won't output the spinner, colors, and other ansi escape codes. It will still log text.
	 */
	isEnabled?: boolean;
}>;

/**
 * Elegant terminal spinner.
 *
 * @param options - If a string is provided, it is treated as a shortcut for `options.text`.
 */
export default function ora(options?: Options | string): Ora;

/**
 * Starts a spinner for a promise. The spinner is stopped with `.succeed()` if the promise fulfills or with `.fail()` if it rejects.
 *
 * @param action - The promise to start the spinner for.
 * @param options - If a string is provided, it is treated as a shortcut for `options.text`.
 * @returns The spinner instance.
 */
export function promise(
	action: PromiseLike<unknown>,
	options?: Options | string
): Ora;

export type PersistOptions = Readonly<{
	/**
	 * Symbol to replace the spinner with.
	 *
	 * @default ' '
	 */
	symbol?: string;

	/**
	 * Text to be persisted after the symbol. Default: Current `text`.
	 */
	text?: string;

	/**
	 * Text to be persisted before the symbol. Default: Current `prefixText`.
	 */
	prefixText?: string;
}>;

export interface Ora {
	/**
	 * A boolean of whether the instance is currently spinning.
	 */
	readonly isSpinning: boolean;

	/**
	 * Change the text after the spinner.
	 */
	text: string;
	
	/**
	 * Change the text before the spinner.
	 */
	prefixText: string;

	/**
	 * Change the spinner color.
	 */
	color: Color;

	/**
	 * Change the spinner.
	 */
	spinner: SpinnerName | Spinner;

	/**
	 * Change the spinner indent.
	 */
	indent: number;

	/**
	 * Start the spinner.
	 *
	 * @param text - Set the current text.
	 * @returns The spinner instance.
	 */
	start(text?: string): Ora;

	/**
	 * Stop and clear the spinner.
	 *
	 * @returns The spinner instance.
	 */
	stop(): Ora;

	/**
	 * Stop the spinner, change it to a green `✔` and persist the current text, or `text` if provided.
	 *
	 * @param text - Will persist text if provided.
	 * @returns The spinner instance.
	 */
	succeed(text?: string): Ora;

	/**
	 * Stop the spinner, change it to a red `✖` and persist the current text, or `text` if provided.
	 *
	 * @param text - Will persist text if provided.
	 * @returns The spinner instance.
	 */
	fail(text?: string): Ora;

	/**
	 * Stop the spinner, change it to a yellow `⚠` and persist the current text, or `text` if provided.
	 *
	 * @param text - Will persist text if provided.
	 * @returns The spinner instance.
	 */
	warn(text?: string): Ora;

	/**
	 * Stop the spinner, change it to a blue `ℹ` and persist the current text, or `text` if provided.
	 *
	 * @param text - Will persist text if provided.
	 * @returns The spinner instance.
	 */
	info(text?: string): Ora;

	/**
	 * Stop the spinner and change the symbol or text.
	 *
	 * @returns The spinner instance.
	 */
	stopAndPersist(options?: PersistOptions): Ora;

	/**
	 * Clear the spinner.
	 *
	 * @returns The spinner instance.
	 */
	clear(): Ora;

	/**
	 * Manually render a new frame.
	 *
	 * @returns The spinner instance.
	 */
	render(): Ora;

	/**
	 * Get a new frame.
	 *
	 * @returns The spinner instance.
	 */
	frame(): Ora;
}
