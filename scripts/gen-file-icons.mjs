/**
 * Builds the file / folder icon set used by the chat and the Files panel.
 *
 * Source: "Material Icon Theme" (MIT) — the icons VS Code users know. We do not
 * ship all 1,250 of them: this picks the extensions, file names and folder names
 * people actually meet, copies just those SVGs (transparent, 16px) into
 * public/file-icons/ and writes a compact lookup table to src/agent/fileIconMap.json.
 *
 *   npm i --no-save material-icon-theme
 *   node scripts/gen-file-icons.mjs
 *
 * (The generated files are committed, so nobody needs to run this to use the app.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const themeDir = process.env.ICON_THEME_DIR || path.join(root, 'node_modules', 'material-icon-theme');
const require = createRequire(path.join(themeDir, 'package.json'));
const { generateManifest } = require(themeDir);
const pkg = JSON.parse(fs.readFileSync(path.join(themeDir, 'package.json'), 'utf8'));
const manifest = generateManifest();

const EXTENSIONS = `html htm xhtml css scss sass less styl js mjs cjs jsx ts mts cts tsx d.ts json jsonc json5 md mdx markdown txt rst
py pyc pyw ipynb java class jar kt kts swift c h cpp cc cxx hpp hh cs csx go rs rb erb php lua pl pm r rmd scala hs ex exs erl clj cljs dart
sh bash zsh fish ps1 psm1 bat cmd sql db sqlite sqlite3 prisma yml yaml toml ini cfg conf env xml xsl svg png jpg jpeg gif webp ico bmp avif tiff
pdf zip tar gz tgz bz2 xz rar 7z lock log csv tsv xlsx xls ods doc docx odt ppt pptx mp3 wav ogg flac m4a mp4 mov avi mkv webm woff woff2 ttf otf eot
wasm vue svelte astro graphql gql proto tf tfvars hcl map test.js test.ts test.jsx test.tsx spec.js spec.ts spec.tsx stories.tsx stories.ts
config.js config.ts mod sum gradle pom nix zig v sol vim ejs hbs pug jade njk twig liquid http rest`.split(/\s+/);

const FILE_NAMES = `package.json package-lock.json yarn.lock pnpm-lock.yaml bun.lockb bun.lock npm-shrinkwrap.json tsconfig.json jsconfig.json tsconfig.base.json
vite.config.js vite.config.ts vite.config.mjs vitest.config.ts vitest.config.js webpack.config.js rollup.config.js rollup.config.mjs esbuild.config.js
tailwind.config.js tailwind.config.ts tailwind.config.cjs postcss.config.js postcss.config.cjs .eslintrc .eslintrc.js .eslintrc.json .eslintrc.cjs eslint.config.js eslint.config.mjs
.prettierrc .prettierrc.json .prettierrc.js prettier.config.js .babelrc babel.config.js jest.config.js jest.config.ts next.config.js next.config.mjs next.config.ts nuxt.config.ts nuxt.config.js
svelte.config.js astro.config.mjs astro.config.ts remix.config.js gatsby-config.js angular.json nest-cli.json dockerfile docker-compose.yml docker-compose.yaml compose.yaml .dockerignore
.gitignore .gitattributes .gitmodules .editorconfig .env .env.example .env.local .env.development .env.production .env.test readme.md readme readme.txt license license.md license.txt
changelog.md contributing.md code_of_conduct.md security.md makefile cmakelists.txt requirements.txt pyproject.toml pipfile pipfile.lock setup.py poetry.lock tox.ini manage.py
cargo.toml cargo.lock go.mod go.sum gemfile gemfile.lock rakefile composer.json composer.lock pom.xml build.gradle build.gradle.kts settings.gradle gradlew
index.html favicon.ico robots.txt sitemap.xml manifest.json .nvmrc .npmrc .yarnrc .yarnrc.yml vercel.json netlify.toml firebase.json .firebaserc procfile app.yaml serverless.yml
.stylelintrc .stylelintrc.json commitlint.config.js .htaccess nginx.conf playwright.config.ts playwright.config.js cypress.config.js cypress.config.ts
.travis.yml .gitlab-ci.yml jenkinsfile .env.sample deno.json deno.jsonc turbo.json lerna.json nx.json .browserslistrc .dockerfile`.split(/\s+/);

const FOLDERS = `src source sources lib libs dist build out output public static assets asset images image img icons icon fonts font css styles style scss sass less js javascript ts typescript
scripts script components component pages page routes route views view layouts layout templates template hooks utils util helpers helper services service api apis server servers client clients
backend frontend app apps packages core common shared models model controllers controller middleware middlewares config configs configuration settings test tests __tests__ spec specs e2e
docs doc documentation node_modules vendor .git .github .vscode .idea database databases db migrations data logs log tmp temp cache .cache types typings interfaces store stores state redux
context contexts i18n locales locale lang languages plugins plugin themes theme tools tool bin python venv .venv env __pycache__ android ios docker kubernetes k8s terraform ci .circleci .husky
coverage examples example samples demo demos resources resource uploads upload downloads download audio video media documents private secure tasks jobs workers queue mocks mock fixtures
stubs seeds schema schemas graphql prisma web mobile desktop widgets modules module features feature domain domains entities repositories dto emails email notifications admin auth
.next .nuxt .svelte-kit .turbo .vite target out-tsc obj debug release ui animations stories storybook .storybook cypress playwright playwright-report test-results`.split(/\s+/);

const lower = (s) => s.toLowerCase();
const extMap = {};
const nameMap = {};
const folderMap = {};
const folderOpenMap = {};
const lightExt = {};
const lightName = {};
const lightFolder = {};
const lightFolderOpen = {};
const needed = new Set();
const use = (n) => {
  if (n) needed.add(n);
  return n;
};

for (const e of EXTENSIONS) if (manifest.fileExtensions[e]) extMap[e] = use(manifest.fileExtensions[e]);
for (const n of FILE_NAMES) if (manifest.fileNames[lower(n)]) nameMap[lower(n)] = use(manifest.fileNames[lower(n)]);
for (const f of FOLDERS) {
  const k = lower(f);
  if (manifest.folderNames[k]) {
    folderMap[k] = use(manifest.folderNames[k]);
    folderOpenMap[k] = use(manifest.folderNamesExpanded[k] || manifest.folderNames[k]);
  }
}

// light-theme overrides for exactly the entries we kept (icons that would vanish on white)
const L = manifest.light || {};
for (const [k, v] of Object.entries(extMap)) if (L.fileExtensions?.[k]) lightExt[k] = use(L.fileExtensions[k]);
for (const [k] of Object.entries(nameMap)) if (L.fileNames?.[k]) lightName[k] = use(L.fileNames[k]);
for (const k of Object.keys(folderMap)) {
  if (L.folderNames?.[k]) lightFolder[k] = use(L.folderNames[k]);
  if (L.folderNamesExpanded?.[k]) lightFolderOpen[k] = use(L.folderNamesExpanded[k]);
}
const defaults = {
  file: use(manifest.file),
  folder: use(manifest.folder),
  folderOpen: use(manifest.folderExpanded),
  root: use(manifest.rootFolder),
  rootOpen: use(manifest.rootFolderExpanded),
  lightFile: use(L.file),
  lightFolder: use(L.folder),
  lightFolderOpen: use(L.folderExpanded),
};
for (const d of ['file', 'folder', 'folderOpen']) if (!defaults[d]) throw new Error(`no default ${d} icon in the manifest`);

// the generic language fallbacks people hit most: unknown extension -> plain file; also keep a handful of generic glyphs
for (const generic of ['console', 'document', 'image', 'database', 'settings', 'tune', 'lock', 'log', 'zip', 'pdf', 'audio', 'video', 'font']) {
  if (manifest.iconDefinitions[generic]) needed.add(generic);
}

const outDir = path.join(root, 'public', 'file-icons');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
let copied = 0;
let bytes = 0;
const missing = [];
for (const name of [...needed].sort()) {
  const def = manifest.iconDefinitions[name];
  const file = def ? path.resolve(path.join(themeDir, 'dist'), def.iconPath) : null;
  if (!file || !fs.existsSync(file)) {
    missing.push(name);
    continue;
  }
  const svg = fs.readFileSync(file);
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  copied++;
  bytes += svg.length;
}
if (missing.length) console.warn('icons without a file (skipped):', missing.join(', '));

const out = {
  _about: `Lookup table for public/file-icons. Generated by scripts/gen-file-icons.mjs from material-icon-theme ${pkg.version} (MIT).`,
  defaults,
  ext: extMap,
  name: nameMap,
  folder: folderMap,
  folderOpen: folderOpenMap,
  light: { ext: lightExt, name: lightName, folder: lightFolder, folderOpen: lightFolderOpen },
};
fs.writeFileSync(path.join(root, 'src', 'agent', 'fileIconMap.json'), JSON.stringify(out, null, 0) + '\n');

fs.copyFileSync(path.join(themeDir, 'LICENSE'), path.join(outDir, 'LICENSE'));
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# File and folder icons\n\nThese SVGs come from **Material Icon Theme** ${pkg.version} (https://github.com/material-extensions/vscode-material-icon-theme),\nMIT licensed, copyright Material Extensions — see LICENSE in this folder.\n\nOnly the subset needed by the chat and the Files panel is included. Regenerate with \`node scripts/gen-file-icons.mjs\`.\n`
);

console.log(
  `icons: ${copied} SVGs (${(bytes / 1024).toFixed(0)} KB) | extensions ${Object.keys(extMap).length} | file names ${Object.keys(nameMap).length} | folders ${Object.keys(folderMap).length} | light overrides ${
    Object.keys(lightExt).length + Object.keys(lightName).length + Object.keys(lightFolder).length
  }`
);
