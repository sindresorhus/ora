'use strict';
var chalk = require('chalk');
var cliCursor = require('cli-cursor');
var cliSpinners = require('cli-spinners');
var objectAssign = require('object-assign');
var EOL = require('os').EOL;

function Ora(options) {
	if (!(this instanceof Ora)) {
		return new Ora(options);
	}

	if (typeof options === 'string') {
		options = {
			text: options
		};
	}

	this.options = objectAssign({
		text: '',
		color: 'cyan',
		split: false, // seperate tasks by text value
		stream: process.stderr
	}, options);

	var sp = this.options.spinner;
	this.spinner = typeof sp === 'object' ? sp : (process.platform === 'win32' ? cliSpinners.line : (cliSpinners[sp] || cliSpinners.dots)); // eslint-disable-line

	if (this.spinner.frames === undefined) {
		throw new Error('Spinner must define `frames`');
	}

	this.text = this.options.text;
	this.color = this.options.color;
	this.interval = this.options.interval || this.spinner.interval || 100;
	this.stream = this.options.stream;
	this.id = null;
	this.frameIndex = 0;
	this.enabled = (this.stream && this.stream.isTTY) && !process.env.CI;
	this.completed = '√';
}

Ora.prototype.setColor = function (color) {
	this.color = color;
};

Ora.prototype.setText = function (text) {
	if (this.options.split) {
		if (this.text !== text) {
			this.complete();
		}
	}
	this.text = text;
};

Ora.prototype.complete = function () {
	this.clear();
	var tick = chalk.green(this.completed);
	this.render(tick + ' ' + this.text + EOL);
};

Ora.prototype.frame = function () {
	var frames = this.spinner.frames;
	var frame = frames[this.frameIndex];

	if (this.color) {
		frame = chalk[this.color](frame);
	}

	this.frameIndex = ++this.frameIndex % frames.length;

	return frame + ' ' + this.text;
};

Ora.prototype.clear = function () {
	if (!this.enabled) {
		return;
	}

	this.stream.clearLine();
	this.stream.cursorTo(0);
};

Ora.prototype.render = function (buffer) {
	buffer = buffer ? buffer : this.frame();
	this.clear();
	this.stream.write(buffer);
};

Ora.prototype.start = function () {
	if (!this.enabled) {
		return;
	}

	cliCursor.hide();
	this.render();
	this.id = setInterval(this.render.bind(this), this.interval);
};

Ora.prototype.done = function () {
	this.complete();
	this.stop();
};

Ora.prototype.stop = function () {
	if (!this.enabled) {
		return;
	}

	clearInterval(this.id);
	this.id = null;
	this.frameIndex = 0;
	this.clear();
	cliCursor.show();
};

module.exports = Ora;
