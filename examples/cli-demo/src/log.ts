// Terminal output helpers for the demo: headings, labelled values and explorer links.

import { Config } from "./config.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

export class Log {
    /** Prints a section heading. */
    static heading(text: string): void {
        console.log(`\n${BOLD}${CYAN}== ${text} ==${RESET}`);
    }

    /** Prints a step in progress. */
    static step(text: string): void {
        console.log(`\n${BOLD}> ${text}${RESET}`);
    }

    /** Prints a labelled value. */
    static info(label: string, value: string): void {
        console.log(`  ${DIM}${label.padEnd(14)}${RESET} ${value}`);
    }

    /** Prints a confirmed transaction hash with its explorer link. */
    static tx(hash: string): void {
        console.log(`  ${GREEN}tx${RESET}             ${hash}`);
        console.log(`  ${DIM}               ${Config.explorerUrl}/tx/${hash}${RESET}`);
    }

    /** Rewrites the current line with a status message. */
    static status(text: string): void {
        process.stdout.write(`\r  ${DIM}${text}${RESET}\x1b[K`);
    }

    /** Ends a line started by `status`. */
    static endStatus(): void {
        process.stdout.write("\n");
    }
}
