import React from 'react';
import { fileIcon, folderIcon } from '../agent/fileIcons';

interface FileTypeIconProps {
  /** A file or folder path (only the last segment matters). */
  path: string;
  isDir?: boolean;
  /** Folders: the "open" variant. */
  open?: boolean;
  className?: string;
}

/**
 * The real file / folder icon (HTML orange, CSS blue, JS yellow, a `css` folder
 * that looks like a CSS folder…). Transparent SVGs, so they sit on any background;
 * where the theme has a light-mode variant, the right one is picked by the app theme.
 */
export const FileTypeIcon: React.FC<FileTypeIconProps> = React.memo(({ path, isDir = false, open = false, className = 'w-4 h-4' }) => {
  const icon = isDir ? folderIcon(path, open) : fileIcon(path);
  const common = 'shrink-0 select-none pointer-events-none';
  if (icon.lightSrc) {
    return (
      <>
        <img src={icon.lightSrc} alt="" aria-hidden draggable={false} className={`${className} ${common} dark:hidden`} data-icon={icon.name} />
        <img src={icon.src} alt="" aria-hidden draggable={false} className={`${className} ${common} hidden dark:block`} data-icon={icon.name} />
      </>
    );
  }
  return <img src={icon.src} alt="" aria-hidden draggable={false} className={`${className} ${common}`} data-icon={icon.name} />;
});
FileTypeIcon.displayName = 'FileTypeIcon';
