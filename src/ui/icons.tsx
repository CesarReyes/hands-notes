import type { ReactNode, SVGProps } from 'react'

function Icon({ children, size = 22, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

type P = SVGProps<SVGSVGElement> & { size?: number }

export const IconPen = (p: P) => (
  <Icon {...p}>
    <path d="M14.5 4.5l5 5L9 20H4v-5L14.5 4.5z" />
    <path d="M12.5 6.5l5 5" />
  </Icon>
)
export const IconHighlighter = (p: P) => (
  <Icon {...p}>
    <path d="M9 15l-3 3v2h5l2-2" />
    <path d="M8.5 13.5L16 6l3 3-7.5 7.5z" />
    <path d="M14 19h7" />
  </Icon>
)
export const IconEraser = (p: P) => (
  <Icon {...p}>
    <path d="M7 20h13" />
    <path d="M4.5 14.5L13 6a2 2 0 012.8 0l3.2 3.2a2 2 0 010 2.8L11 20H8z" />
    <path d="M9 10l6 6" />
  </Icon>
)
export const IconLasso = (p: P) => (
  <Icon {...p}>
    <path d="M7 17c-2.5-1.3-4-3.3-4-5.5C3 7.4 7 4 12 4s9 3.4 9 7.5S17 19 12 19c-1 0-2-.1-2.9-.4" strokeDasharray="2.5 2.5" />
    <path d="M7 17c0 2 1.5 3 3 3" />
  </Icon>
)
export const IconUndo = (p: P) => (
  <Icon {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 010 12h-3" />
  </Icon>
)
export const IconRedo = (p: P) => (
  <Icon {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 000 12h3" />
  </Icon>
)
export const IconBack = (p: P) => (
  <Icon {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
)
export const IconPlus = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
export const IconImage = (p: P) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M20.5 16l-5-5L6 19.5" />
  </Icon>
)
export const IconPages = (p: P) => (
  <Icon {...p}>
    <rect x="4" y="3" width="7" height="9" rx="1.5" />
    <rect x="13" y="3" width="7" height="9" rx="1.5" />
    <rect x="4" y="14" width="7" height="7" rx="1.5" />
    <rect x="13" y="14" width="7" height="7" rx="1.5" />
  </Icon>
)
export const IconMore = (p: P) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </Icon>
)
export const IconTrash = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" />
    <path d="M9 7V4h6v3" />
  </Icon>
)
export const IconCopy = (p: P) => (
  <Icon {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
  </Icon>
)
export const IconCloud = (p: P) => (
  <Icon {...p}>
    <path d="M7 18a4.5 4.5 0 01-.5-9 6 6 0 0111.5 1.5A3.75 3.75 0 0117.5 18z" />
  </Icon>
)
export const IconCloudOff = (p: P) => (
  <Icon {...p}>
    <path d="M7 18a4.5 4.5 0 01-.5-9M9.5 6A6 6 0 0118 10.5 3.75 3.75 0 0119.8 17" />
    <path d="M3 3l18 18" />
  </Icon>
)
export const IconCheck = (p: P) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)
export const IconSearch = (p: P) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </Icon>
)
export const IconUser = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0116 0" />
  </Icon>
)
export const IconDownload = (p: P) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5" />
    <path d="M5 20h14" />
  </Icon>
)
export const IconImport = (p: P) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 18v-6M9 15l3-3 3 3" />
  </Icon>
)
export const IconX = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)
export const IconArrowUp = (p: P) => (
  <Icon {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
)
export const IconArrowDown = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
)
export const IconZoomReset = (p: P) => (
  <Icon {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Icon>
)
export const IconNotebook = (p: P) => (
  <Icon {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 3v18M12 8h4M12 12h4" />
  </Icon>
)
