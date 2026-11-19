#!/usr/bin/env node
import { main } from './lib/main';

process.exitCode = main(process.argv.slice(2), process.cwd());
