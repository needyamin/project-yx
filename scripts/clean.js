#!/usr/bin/env node
/**
 * Remove generated distribution artifacts only (never source).
 */
import { cleanReleaseArtifacts } from "./lib/clean-artifacts.js";

cleanReleaseArtifacts();
console.log("[yx-dist] clean complete");
