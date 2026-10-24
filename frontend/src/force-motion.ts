// The monitor is a live, animated view, so it always animates, even when the operating
// system asks apps to reduce motion (Windows "Animation effects" off). Arc components and
// the ocean read that preference through matchMedia; this makes them see "no preference".
// Must be imported before anything else (see main.tsx). The matching CSS rules are dropped
// at build time in vite.config.ts.
const realMatchMedia = window.matchMedia.bind(window);

window.matchMedia = (query: string): MediaQueryList => {
  if (/prefers-reduced-motion/.test(query)) {
    const wantsReduce = !/no-preference/.test(query);
    return realMatchMedia(wantsReduce ? "not all" : "all");
  }
  return realMatchMedia(query);
};

export {};
