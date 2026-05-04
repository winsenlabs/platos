# Platos Design Tokens

Canonical reference for the Platos visual language. The marketing site at `platos.dev` mirrors these exactly. All values extracted from `apps/webapp/tailwind.config.js` and verified against real component usage in `apps/webapp/app/components/**`.

The webapp is dark-first. Every value below assumes a dark surface; there is no light mode.

---

## 1. Colors

### 1.1 Surfaces (charcoal — primary background ramp)

The entire dashboard sits on the `charcoal` ramp. `charcoal-900` is the page body. Cards / nav / inputs step up to `charcoal-800` / `charcoal-750`. Hover states step up one more rung.

| Token            | Hex       | Usage                                                |
|------------------|-----------|------------------------------------------------------|
| `charcoal-100`   | `#E8E9EC` | (rare; very light surface, inverse banners)          |
| `charcoal-200`   | `#D7D9DD` | `text-bright` baseline                               |
| `charcoal-300`   | `#B5B8C0` |                                                      |
| `charcoal-400`   | `#878C99` | `text-dimmed` baseline                               |
| `charcoal-500`   | `#5F6570` | de-emphasized text on dark                           |
| `charcoal-550`   | `#4D525B` | hover border for secondary buttons                   |
| `charcoal-600`   | `#3B3E45` | secondary button border, hover bg `charcoal-600`     |
| `charcoal-650`   | `#2C3034` | input border, badge border, `grid-dimmed`            |
| `charcoal-700`   | `#272A2E` | `tertiary` button bg, dividers, borders, code blocks |
| `charcoal-750`   | `#212327` | input fill, hover bg, sidebar accent                 |
| `charcoal-775`   | `#1C1E21` |                                                      |
| `charcoal-800`   | `#1A1B1F` | `background-bright` (cards, panels)                  |
| `charcoal-850`   | `#15171A` | `background-dimmed` (page body — DEFAULT)            |
| `charcoal-900`   | `#121317` | deepest surface (modals over modals)                 |
| `charcoal-950`   | `#0D0E12` | edge cases, icon mark background                     |
| `charcoal-1000`  | `#0B0C0F` | absolute black-ish                                   |

Aliases:
- `bg-background-dimmed` → `#15171A` (charcoal-850) — body default
- `bg-background-bright` → `#1A1B1F` (charcoal-800) — cards, sidebar
- `border-grid-bright` → `#272A2E` (charcoal-700)
- `border-grid-dimmed` → `#212327` (charcoal-750)

### 1.2 Brand accent — toxic + acid (the green Platos uses, NOT emerald)

The signature Platos green. The 404 logo, the gradient-primary CTA, the glow-primary shadow all use this pair. `toxic-500` → `acid-400` is the canonical brand gradient (see `bg-gradient-primary`).

**toxic** (vivid green):
| Token       | Hex       |
|-------------|-----------|
| toxic-50    | `#E3FFE6` |
| toxic-100   | `#C8FFCD` |
| toxic-200   | `#A9FFAB` |
| toxic-300   | `#8AFF96` |
| toxic-400   | `#6DFC7B` |
| toxic-500   | `#41FF54` ← brand primary |
| toxic-600   | `#28F03C` |
| toxic-700   | `#2AE03C` |
| toxic-800   | `#22D834` |
| toxic-900   | `#16CC28` |

**acid** (yellow-green):
| Token       | Hex       |
|-------------|-----------|
| acid-50     | `#F9FFD1` |
| acid-100    | `#F6FFB6` |
| acid-200    | `#F3FF99` |
| acid-300    | `#EEFF82` |
| acid-400    | `#E7FF52` ← brand secondary, gradient endpoint |
| acid-500    | `#DAF437` |
| acid-600    | `#C5E118` |
| acid-700    | `#B2CD0A` |
| acid-800    | `#A5BE07` |
| acid-900    | `#9FB802` |

> Note: `toxic` and `acid` are documented in the tailwind config but exported via raw hex (the file defines them as JS variables, not in the `theme.extend.colors` block). The marketing site should expose them as full tokens. Brand gradient: `linear-gradient(90deg, #DAF437 0%, #41FF54 100%)`.

### 1.3 Brand secondary — apple (sub-brand green) and lavender (link)

`apple` is exported as a Tailwind color and used as `primary` (positive accent on text + status pills). `lavender` is exported and used for links and the secondary gradient.

**apple:**
| Token       | Hex       | Usage                                  |
|-------------|-----------|----------------------------------------|
| apple-100   | `#E4FFC9` |                                        |
| apple-200   | `#CFFFA0` |                                        |
| apple-300   | `#BFFF81` |                                        |
| apple-400   | `#AFFF62` |                                        |
| apple-500   | `#A8FF53` ← `primary` text alias       |
| apple-600   | `#82D134` |                                        |
| apple-700   | `#6FB12F` |                                        |
| apple-750   | `#5E932A` |                                        |
| apple-800   | `#45711A` |                                        |
| apple-850   | `#2E4E10` |                                        |
| apple-900   | `#20370A` |                                        |
| apple-950   | `#152506` |                                        |

**lavender:**
| Token         | Hex       | Usage                       |
|---------------|-----------|-----------------------------|
| lavender-100  | `#eae8ff` |                             |
| lavender-200  | `#d7d4ff` |                             |
| lavender-300  | `#bab2ff` |                             |
| lavender-400  | `#826dff` ← `text-link`     |
| lavender-500  | `#7655fd` |                             |
| lavender-600  | `#6532f5` |                             |
| lavender-700  | `#5620e1` |                             |
| lavender-800  | `#481abd` |                             |
| lavender-900  | `#3d189a` |                             |
| lavender-950  | `#230c69` |                             |

### 1.4 Semantic colors

| Token         | Source              | Hex       | Usage                                    |
|---------------|---------------------|-----------|------------------------------------------|
| `success`     | `mint-500`          | `#28BF5C` | success pills, prod env                  |
| `pending`     | `blue-500`          | `#3B82F6` | pending states                           |
| `warning`     | `amber-500`         | `#F59E0B` | warning callouts                         |
| `error`       | `rose-600`          | `#E11D48` | destructive buttons, error pills         |
| `text-link`   | `lavender-400`      | `#826dff` | inline links                             |
| `text-bright` | `charcoal-200`      | `#D7D9DD` | primary text                             |
| `text-dimmed` | `charcoal-400`      | `#878C99` | secondary text                           |
| `primary`     | `apple-500`         | `#A8FF53` | positive accent text                     |
| `secondary`   | `charcoal-650`      | `#2C3034` | secondary button surface                 |
| `tertiary`    | `charcoal-700`      | `#272A2E` | tertiary button surface                  |

### 1.5 Environment colors

| Env       | Token           | Hex       |
|-----------|-----------------|-----------|
| dev       | `pink-500`      | `#EC4899` |
| staging   | `orange-400`    | `#FB923C` |
| preview   | `yellow-400`    | `#FACC15` |
| prod      | `mint-500`      | `#28BF5C` |

### 1.6 Sidebar / categorical icon colors

The dashboard sidebar uses tabler-icons in distinct hues per section. Mirror these on marketing site nav cards.

| Section                | Tailwind            | Hex       |
|------------------------|---------------------|-----------|
| tasks                  | `blue-500`          | `#3B82F6` |
| runs                   | `indigo-500`        | `#6366F1` |
| batches                | `pink-500`          | `#EC4899` |
| schedules              | `yellow-500`        | `#EAB308` |
| queues                 | `purple-500`        | `#A855F7` |
| query                  | `blue-500`          | `#3B82F6` |
| metrics                | `green-500`         | `#22C55E` |
| custom-dashboards      | `charcoal-400`      | `#878C99` |
| deployments            | `green-500`         | `#22C55E` |
| concurrency            | `amber-500`         | `#F59E0B` |
| limits                 | `purple-500`        | `#A855F7` |
| regions                | `green-500`         | `#22C55E` |
| logs                   | `pink-500`          | `#EC4899` |
| tests                  | `lime-500`          | `#84CC16` |
| api-keys               | `amber-500`         | `#F59E0B` |
| environment-variables  | `pink-500`          | `#EC4899` |
| alerts                 | `red-500`           | `#EF4444` |
| project-settings       | `blue-500`          | `#3B82F6` |
| org-settings           | `blue-500`          | `#3B82F6` |
| docs                   | `blue-500`          | `#3B82F6` |
| bulk-actions           | `emerald-500`       | `#10B981` |
| ai-prompts             | `blue-500`          | `#3B82F6` |
| ai-metrics             | `green-500`         | `#22C55E` |
| errors                 | `amber-500`         | `#F59E0B` |

### 1.7 Mint and sun ramps (used for status + highlight)

**mint** (success / prod):
50 `#F0FDF4` · 100 `#DDFBE6` · 200 `#BDF5D0` · 300 `#87EBA9` · 400 `#4FD97E` · 500 `#28BF5C` · 600 `#1B9E48` · 700 `#197C3C` · 800 `#196233` · 900 `#16512C` · 950 `#062D15`

**sun** (highlight / warning bright):
50 `#FDFEE8` · 100 `#FDFFC2` · 200 `#FFFF89` · 300 `#FFF852` · 400 `#FDEA12` · 500 `#ECCF06` · 600 `#CCA302` · 700 `#A37505` · 800 `#865B0D` · 900 `#724B11` · 950 `#432705`

### 1.8 Slate and midnight (legacy V2 palette — used in older marketing surfaces)

V3 charcoal is preferred for new work. `slate` and `midnight` are still defined and may surface in older components.

**slate (V2):** 450 `#7E8FA6` · 500 `#6B7C95` · 550 `#586981` · 600 `#45566D` · 650 `#3C4B62` · 750 `#293649` · 850 `#1A2434` · 900 `#131B2B` · 950 `#0E1521` · 1000 `#0B1018`

`midnight` is `slate` re-keyed to specific stops (450 → `slate-850`, 500 → `slate-650`, etc.). For marketing-site work, prefer `charcoal`.

---

## 2. Typography

### 2.1 Font families

```
--font-sans: "Geist Variable", "Helvetica Neue", "Helvetica", "Arial", sans-serif
--font-mono: "Geist Mono Variable", "monaco", "Consolas", "Lucida Console", monospace
```

Loaded via `non.geist` and `non.geist/mono` (npm packages, self-hosted). Marketing site can pull the same packages or `@vercel/font/geist`.

Body sets `font-feature-settings: "rlig" 1, "calt" 1;`.

### 2.2 Custom font sizes

In addition to Tailwind defaults (`xs`, `sm`, `base`, `lg`, etc.) the webapp adds two custom sizes:

| Token  | Size       | Line-height  | Letter-spacing | Weight |
|--------|------------|--------------|----------------|--------|
| `xxs`  | `0.65rem`  | `0.75rem`    | `-0.01em`      | 500    |
| `2sm`  | `0.8125rem`| `0.875rem`   | `-0.01em`      | 500    |

### 2.3 Weights

Use weights inherited from Tailwind. Headers in components use `font-semibold` (600); buttons use `font-normal` (400) by default and `font-medium` (500) only on `large` / `extra-large` variants.

---

## 3. Components

### 3.1 Buttons (`apps/webapp/app/components/primitives/Buttons.tsx`)

All buttons share:
```
font-normal text-center font-sans justify-center items-center shrink-0
transition duration-150 rounded-[3px] select-none
group-focus/button:outline-none focus-custom
```

Sizes:
| Size        | className                                   |
|-------------|---------------------------------------------|
| small       | `h-6 px-2.5 text-xs`                        |
| medium      | `h-8 px-3 text-sm`                          |
| large       | `h-10 px-2 text-base font-medium`           |
| extra-large | `h-12 px-2 text-base font-medium`           |

Themes — copy these className strings verbatim.

**primary** (indigo CTA — used for submit + main actions):
```
text-text-bright transition group-hover/button:text-white
bg-indigo-600 border border-indigo-500
group-hover/button:bg-indigo-500 group-hover/button:border-indigo-400
```

**secondary** (charcoal — used for non-primary actions):
```
text-text-bright
bg-secondary border border-charcoal-600
group-hover/button:bg-charcoal-600 group-hover/button:border-charcoal-550
```

**tertiary** (slightly darker — used for inline actions):
```
text-text-bright
bg-tertiary
group-hover/button:bg-charcoal-600
```

**minimal** (text-only, hover surfaces a fill):
```
text-text-dimmed
bg-transparent
group-hover/button:bg-tertiary
```

**danger** (destructive):
```
text-text-bright group-hover/button:text-white
bg-error
group-hover/button:bg-rose-500
```

**docs** (blue-tinted, used on Docs callouts):
```
text-blue-200/70
bg-charcoal-700 border border-charcoal-600/50 shadow
group-hover/button:bg-charcoal-650
icon: text-blue-500
```

### 3.2 Status badges (`apps/webapp/app/components/primitives/Badge.tsx`)

| Variant         | className                                                                                                         |
|-----------------|-------------------------------------------------------------------------------------------------------------------|
| default         | `rounded-full px-2 h-5 tracking-wider text-xxs bg-charcoal-750 text-text-bright uppercase`                        |
| extra-small     | `rounded-sm px-1 h-4 text-xxs border border-charcoal-650 bg-background-bright text-blue-500`                      |
| small           | `rounded-sm px-1 h-5 text-xs border border-charcoal-650 bg-background-bright text-blue-500`                       |
| outline-rounded | `rounded-full px-1 h-4 tracking-wider text-xxs border border-blue-500 text-blue-500 uppercase`                    |
| rounded         | `rounded-full px-1.5 h-4 text-xxs bg-blue-600 text-text-bright uppercase`                                         |
| success         | `rounded-full px-2 h-5 tracking-wider text-xxs bg-emerald-950 text-emerald-300 border border-emerald-800 uppercase` |
| error           | `rounded-full px-2 h-5 tracking-wider text-xxs bg-rose-950 text-rose-300 border border-rose-800 uppercase`        |

Pattern: pills use `bg-{color}-950` + `text-{color}-300` + `border-{color}-800` + `uppercase tracking-wider text-xxs`. Use this for any new semantic pill.

### 3.3 Form inputs (`apps/webapp/app/components/primitives/Input.tsx`)

Wrapper container (per size):

| Size    | container                                                                                                          | input-text       |
|---------|--------------------------------------------------------------------------------------------------------------------|------------------|
| large   | `px-1 w-full h-10 rounded-[3px] border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-600 hover:bg-charcoal-650` | (text-base)      |
| medium  | `px-1 h-8 w-full rounded border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-600 hover:bg-charcoal-650`        | `text-sm`        |
| small   | `px-1 h-6 w-full rounded border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-600 hover:bg-charcoal-650`        | `text-xs`        |
| tertiary| `px-1 h-6 w-full rounded border border-charcoal-600 hover:border-charcoal-550 bg-grid-dimmed hover:bg-charcoal-650`         | `text-xs`        |
| ghost   | `px-1 h-6 w-full rounded hover:bg-charcoal-750`                                                                              | `text-xs`        |

Focus ring (applied via `has-[:focus-visible]:`):
```
ring-1 ring-charcoal-650 ring-offset-0
```

Inner `<input>` element is always `bg-transparent text-text-bright placeholder:text-muted-foreground` — visual styling lives on the wrapper.

### 3.4 Cards / panels

There is no `Card` primitive. Cards = manual composition:

```
bg-background-bright       (charcoal-800)
border border-grid-bright  (charcoal-700)
rounded-[0.5rem]           (radius-lg)
p-4
```

Sidebar pattern:
```
border-r border-grid-bright bg-background-bright
```

### 3.5 Code blocks (`tailwind.css` + `CodeBlock.tsx`)

```
bg-charcoal-800           (header)
text-text-dimmed           (header text)
border-b border-charcoal-700
content body uses charcoal-700/charcoal-650 borders, scrollbar-thin scrollbar-thumb-charcoal-600
font-mono
```

Inline code: `bg-charcoal-700 px-1 py-0.5 rounded text-text-bright font-mono`.

### 3.6 Selection + scrollbar

```
::selection { @apply bg-text-bright/30 text-text-bright; }
```

Scrollbars (via `tailwind-scrollbar`):
```
scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600
```

---

## 4. Spacing + Radius

### 4.1 Border radius

```
--radius:    0.5rem         (rounded-lg, default for cards/panels)
rounded-md:  calc(0.5rem - 2px)
rounded-sm:  calc(0.5rem - 4px)
rounded-[3px]:  buttons, focus outline (sharper than default sm)
```

### 4.2 Common gap / padding values

| Where         | Value                  |
|---------------|------------------------|
| Card padding  | `p-4`                  |
| Section gap   | `gap-2` / `gap-3`      |
| Inline gap    | `gap-x-2.5`            |
| Sidebar item  | `pl-[0.4375rem] h-8`   |
| Button icon   | `-mx-1 h-4` (medium)   |
| Modal padding | `p-6`                  |

### 4.3 Custom width / height steps

```
w-0.75 / h-0.75 = 0.1875rem   (3px)
w-4.5  / h-4.5  = 1.125rem    (18px) — used for `small-menu-item` icons
size-4.5         = 1.125rem
```

---

## 5. Iconography

### 5.1 Library

Two icon libraries, used in different surfaces:

- **`@tabler/icons-react`** (`^3.36.1`) — primary; sidebar nav, page headers, action buttons, badges. Use for everything new.
- **`lucide-react`** (`^0.229.0`) — legacy / scattered; do not introduce in new components.

### 5.2 Standard sizes

| Where                   | className                       |
|-------------------------|---------------------------------|
| Inline body text        | `h-4 w-4` (size-4)              |
| Button icon (medium)    | `h-4`                           |
| Button icon (large)     | `h-5`                           |
| Sidebar nav             | `h-5` or `size-5`               |
| Compact menu items      | `h-[1.125rem]` (4.5)            |
| Page header             | `size-6`                        |

### 5.3 Color

Icons inherit text color via `currentColor`. Sidebar categorical icons use the colors from §1.6.

---

## 6. Motion

### 6.1 Library

`framer-motion` for spring animations + stateful transitions (active tab indicator, page transitions, modal). `@radix-ui` primitives provide animation classes via `tailwindcss-animate`.

### 6.2 Standard durations

| Use                           | Value                                              |
|-------------------------------|----------------------------------------------------|
| Hover / state toggle          | `transition duration-150` (default for buttons)    |
| Color / opacity transitions   | `transition duration-200`                          |
| Tab indicator (spring)        | `framer transition={{ type: "spring", stiffness: 500, damping: 30 }}` |
| Tab content fade (spring)     | `framer transition={{ duration: 0.4, type: "spring" }}`               |
| Sidebar collapse              | `transition-all duration-200`                      |
| Accordion open/close          | `accordion-down 0.2s ease-out` / `accordion-up 0.2s ease-out`         |
| 404 logo spin                 | `framer transition={{ duration: 60, ease: "linear", repeat: Infinity }}` |
| Tile-scroll loader            | `tile-move 0.5s infinite linear`                   |

### 6.3 Glow shadows

```
shadow-glow-primary:   0 0 10px 5px rgba(218, 244, 55, 0.2)   (acid)
shadow-glow-secondary: 0 0 10px 5px rgba(79, 70, 229, 0.2)    (indigo-600)
shadow-glow-pink:      0 0 10px 5px rgba(236, 72, 153, 0.2)
```

Used on hero CTAs and the "primary" gradient button hover.

### 6.4 Animated gradient ring (for emphasis surfaces)

The `.animated-gradient-glow` utility wraps an element in a rotating conic-gradient blur ring:
```
indigo-500 → amber-500 → pink-500 → amber-500 → indigo-500
3s linear infinite, blur(0.5rem), opacity 0.1
```
Use sparingly — currently powers a single "premium" callout.

---

## 7. Background gradients

Three named gradients are exported via Tailwind's `backgroundImage`:

```
bg-gradient-primary:        linear-gradient(90deg, acid-500 0%, toxic-500 100%)
bg-gradient-primary-hover:  linear-gradient(80deg, acid-600 0%, toxic-600 100%)
bg-gradient-secondary:      linear-gradient(90deg, hsl(271 91 65) 0%, hsl(221 83 53) 100%)   (purple → blue)
bg-gradient-radial-secondary: radial-gradient(hsl(271 91 65), hsl(221 83 53))
bg-gradient-radial:         radial-gradient(closest-side, var(--tw-gradient-stops))
```

Brand mark gradient (logo SVG and 404 icon):
```
linear-gradient(135deg, #41FF54 0%, #E7FF52 100%)
```

---

## 8. Focus styles

Custom utility, applied via `class="focus-custom"`:
```
outline: 1px solid
outlineOffset: 0px
outlineColor: lavender-400  (#826dff, the text-link color)
borderRadius: 3px
```

All interactive primitives (buttons, links, form fields) carry `focus-custom`.

---

## 9. Logo assets

| Asset                                     | Path                                              | Use                                       |
|-------------------------------------------|---------------------------------------------------|-------------------------------------------|
| Square icon mark (SVG, scales cleanly)    | `apps/webapp/public/images/platos-icon.svg`       | In-app `<LogoIcon>`, OG cards, hero       |
| Square icon mark (ICO, browser favicon)   | `apps/webapp/public/images/platos-icon.ico`       | Favicon ONLY — do not render at >16px     |
| Browser favicon                            | `apps/webapp/public/favicon.ico`                  | Default browser favicon path              |
| Landscape wordmark (PNG, 1:6 aspect)      | `apps/webapp/public/images/platos-logotype.png`   | In-app `<LogoType>`, sidebar header, login|

Marketing site should re-export these assets from `/static/brand/`. Always prefer SVG over PNG for the icon mark; reserve the ICO for the actual `<link rel="icon" href="/favicon.ico">` slot.

---

## 10. Plugins enabled

```
@tailwindcss/container-queries
@tailwindcss/forms
@tailwindcss/typography
tailwindcss-animate
tailwind-scrollbar
tailwind-scrollbar-hide
tailwindcss-textshadow
```

The marketing site should match this plugin set so any copy-pasted className strings render identically.

---

## Source of truth

- `apps/webapp/tailwind.config.js`
- `apps/webapp/app/tailwind.css`
- `apps/webapp/app/components/primitives/Buttons.tsx`
- `apps/webapp/app/components/primitives/Badge.tsx`
- `apps/webapp/app/components/primitives/Input.tsx`
- `apps/webapp/app/components/navigation/SideMenu.tsx`

If this doc and the config disagree, the config wins. Update this file rather than the marketing site.
