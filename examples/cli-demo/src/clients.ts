// The demo's chain reader and transaction submitter, built from its network settings.

import { Chain, Submitter } from "@agentkred/shared";
import { Config } from "./config.js";

export const chain = new Chain(Config.network);

export const submitter = new Submitter(chain);
