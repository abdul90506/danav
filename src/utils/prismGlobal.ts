// Prism's language components (prismjs/components/*) are written for a browser
// global: they read `Prism` as a free variable and register on it. In the
// production bundle that global is not set, so they throw "Prism is not defined"
// and the whole app renders blank. Expose the library before they load.
import Prism from 'prismjs';

(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

export default Prism;
