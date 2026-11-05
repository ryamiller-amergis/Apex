import Link from '@mui/material/Link';

export interface SkipLinkProps {
  targetId: string;
}

/**
 * The first tab stop. Hidden until focused; activating it moves focus to the
 * element with `targetId`.
 */
export const SkipLink: React.FC<SkipLinkProps> = ({ targetId }) => {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(targetId);
    if (!target) {
      return;
    }
    event.preventDefault();
    target.focus();
  };

  return (
    <Link
      href={`#${targetId}`}
      onClick={handleClick}
      data-testid="app-shell-skip-link"
      sx={{
        position: 'absolute',
        top: (theme) => theme.spacing(1),
        left: (theme) => theme.spacing(1),
        zIndex: (theme) => theme.zIndex.tooltip + 1,
        px: 2,
        py: 1,
        bgcolor: 'background.paper',
        transform: 'translateY(-200%)',
        '&:focus': { transform: 'none' },
      }}
    >
      Skip to main content
    </Link>
  );
};
