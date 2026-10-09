import React, { useState, useMemo } from 'react';
import { Check, Copy } from 'lucide-react';
import Prism from '../utils/prismGlobal';
import { copyText } from '../utils/clipboard.ts';

// Import essential language grammars
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';

interface CodeBlockProps {
  language?: string;
  value: string;
}

const langAliases: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  yml: 'yaml',
  golang: 'go',
  cs: 'csharp',
  rb: 'ruby',
};

/** Languages that mean "do not colour this at all". */
const PLAIN_LANGS = new Set(['text', 'plain', 'plaintext', 'txt', 'none', 'output', 'log', '']);

export const CodeBlock: React.FC<CodeBlockProps> = ({ language = 'text', value }) => {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const normalizedLang = useMemo(() => {
    const raw = (language || 'text').toLowerCase().trim();
    return langAliases[raw] || raw;
  }, [language]);

  const highlightedHtml = useMemo(() => {
    // Plain text is NOT javascript. Falling back to the JS grammar meant a
    // ```text block had "let", "for" and quoted words coloured as code, which
    // reads as if the text were broken. Unknown languages render plain too —
    // wrong colours are worse than none.
    if (PLAIN_LANGS.has(normalizedLang)) return '';
    try {
      const grammar = Prism.languages[normalizedLang];
      if (grammar) {
        return Prism.highlight(value, grammar, normalizedLang);
      }
    } catch (e) {
      // Fall through to the plain rendering below.
    }
    return '';
  }, [value, normalizedLang]);

  const handleCopy = async () => {
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    // Say so instead of looking dead: this environment refused both copy paths.
    setCopyFailed(true);
    setTimeout(() => setCopyFailed(false), 2500);
  };

  return (
    <div className="relative my-3.5 rounded-xl border border-zinc-200/90 dark:border-zinc-800 bg-[#f8f9fa] dark:bg-[#161618] text-zinc-900 dark:text-zinc-100 font-mono shadow-sm transition-colors overflow-clip">
      {/* Sticky Header bar: Stays pinned to the top as user scrolls through code */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-3.5 py-1.5 bg-[#f0f1f3]/95 dark:bg-[#1f1f23]/95 backdrop-blur-md border-b border-zinc-200/80 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 select-none rounded-t-xl">
        <span className="font-semibold tracking-wider uppercase text-[11px] text-zinc-600 dark:text-zinc-400 font-sans">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy code"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-sans text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-200/70 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied!</span>
            </>
          ) : copyFailed ? (
            <>
              <Copy className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span className="text-amber-600 dark:text-amber-400 font-medium">Select to copy</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code contents: syntax colored, smooth scroll, compact 11px font size */}
      <div className="p-3 overflow-x-auto text-[11px] leading-normal sm:leading-relaxed">
        <pre className="m-0 font-mono whitespace-pre bg-transparent p-0 text-[11px]">
          {highlightedHtml ? (
            <code
              className={`language-${normalizedLang}`}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <code className="text-zinc-800 dark:text-zinc-200">{value}</code>
          )}
        </pre>
      </div>
    </div>
  );
};

