import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';

/** Three-line menu glyph. Decorative unless `titleAccess` is set. */
export const MenuIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props}>
    <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
  </SvgIcon>
);

/** Close (X) glyph. Decorative unless `titleAccess` is set. */
export const CloseIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props}>
    <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </SvgIcon>
);
