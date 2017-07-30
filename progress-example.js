'use strict';
const Ora = require('.');

let progress = 0;

const timeoutPromise = timeout =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, timeout);
  }).then(() => {
    progress++;
  });

const promises = [
  timeoutPromise(1000),
  timeoutPromise(2000),
  timeoutPromise(3000),
  timeoutPromise(300),
  timeoutPromise(4000)
];

const progressCb = () => {
  const percent = Math.round(progress / promises.length * 100);
  return `${percent}/100%`;
};

const spinner = new Ora({
  progress: progressCb,
  text: 'Loading unicorns',
  spinner: process.argv[2]
});

spinner.start();

Promise.all(promises).then(() => spinner.succeed());
