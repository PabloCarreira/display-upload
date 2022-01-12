#!/usr/bin/env node

const program = require('commander');
const chalk = require('chalk');
const package = require('../package.json');
const displayUpload = require('../src/index');

console.log(`Welcome to ${chalk.green.bold(`the Display.Monks Upload Tool`)} v${package.version}`);

program
	.version(package.version)
	.parse(process.argv);

// program

displayUpload({}, true);