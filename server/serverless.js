import serverless from "serverless-http";
import { assertConfig } from "./config.js";
import { createApp } from "./app.js";

/**
 * Entry point for function platforms (Netlify Functions, Vercel, AWS Lambda).
 * See netlify/functions/app.mjs and the README's deployment notes: these platforms
 * have no persistent disk, so swap server/store.js for a hosted store (e.g. Redis)
 * before using them in production.
 */
assertConfig();
export const handler = serverless(createApp());
