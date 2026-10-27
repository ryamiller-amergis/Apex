/// <reference types="node" />
import { runContrastCli } from './contrastCli.js';

process.exitCode = await runContrastCli(process.argv.slice(2));
