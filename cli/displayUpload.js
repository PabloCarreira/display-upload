#!/usr/bin/env node

const program = require('commander');
const chalk = require('chalk');
const packageJson = require('../package.json');
const displayUpload = require('../src/index');

console.log(`Welcome to the ${chalk.green.bold(`Display.Monks Upload Tool`)} v${packageJson.version}`);

program
	.version(packageJson.version)
	.option('-t, --type <data>', 'preview type i.e. mm-preview, adform, flashtalking')
	.option('-i, --inputDir <data>', 'input folder i.e. ./build')
	.option('-o, --outputDir <data>', '(only for mm-preview) output path i.e. fd355e6c-6d4b-4e8f-a509-3d96b8527056/display-ads')
	.parse(process.argv);

const options = program.opts();

// program
displayUpload(options, true).then(result => console.log(`${chalk.green('✔')} done`));
