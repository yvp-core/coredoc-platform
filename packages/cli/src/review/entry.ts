#!/usr/bin/env node
import { Command } from 'commander';
import { isAbortedControlWrite } from './claude-code-runtime.js';
import { registerReviewCommand } from './command.js';

// A small action entry point avoids the ordinary CLI's configuration migration and telemetry boot.
process.on('unhandledRejection', (reason) => {
  if (!isAbortedControlWrite(reason)) throw reason;
});

const program = new Command().name('coredoc-review');
registerReviewCommand(program);
await program.parseAsync(process.argv);
