/**
 * The application's single ViewportManager, created during startup in
 * main.js. Modules read it through `getViewport()` instead of a shared
 * module-level variable.
 */

let viewport = null;

export function setViewport(v) {
  viewport = v;
}

export function getViewport() {
  return viewport;
}
