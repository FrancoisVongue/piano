# Piano Design System Documentation

## 1. Description

Piano is an intelligent design system built for parallel AI task orchestration interfaces. It embodies the philosophy that the best design is felt, not just seen—reducing cognitive load through perceptually uniform colors, spring physics animations, and fluid typography. The system creates interfaces that feel like extensions of the user's mind rather than tools to operate.

Core principles:
- **Perceptually Uniform**: Mathematical color and spacing scales ensure predictable visual relationships
- **Living Motion**: Spring physics create natural, responsive animations that feel alive
- **Cognitive Optimization**: Every element is designed to reduce mental overhead through skeleton loading, z-depth hierarchy, and progressive disclosure
- **Command-First**: Keyboard-driven interactions enable flow state and expert-level efficiency

The design language balances sophisticated minimalism with warm, approachable aesthetics. Deep emerald accents against warm grays create a unique identity that stands apart from typical AI interfaces while maintaining professional elegance.

---

## 2. Fonts

### Display Font
**Bricolage Grotesque** (Variable: 400-800)
- Modern, confident display typeface with strong character
- Used for main headings and brand elements
- Creates distinctive personality while maintaining readability

### Body Font  
**Inter** (Variable: 400-800)
- Highly optimized for screen reading with excellent clarity
- System-like familiarity with refined details
- Perfect for extended reading and UI elements

### Monospace Font
**JetBrains Mono** (400, 500)
- Exceptional legibility for code and data
- Thoughtfully designed ligatures for programming
- Clear distinction between similar characters

### Font Sizes (Fluid Scale)
- **Display**: 60-68px (clamp-based responsive)
- **Heading 1**: 48-55px (clamp-based responsive)
- **Heading 2**: 38-42px (clamp-based responsive)
- **Heading 3**: 30-34px (clamp-based responsive)
- **Body Large**: 19-21px (clamp-based responsive)
- **Body**: 16-18px (clamp-based responsive) - Base size for comfortable reading
- **Small**: 14px - Secondary text and captions
- **X-Small**: 12px - Labels and metadata

### Typography Guidelines
- Line height: 1.6-1.7 for body text, 1.1-1.4 for headings
- Letter spacing: -0.03em for display, -0.01em for body
- Always use variable font weights for smoother transitions
- Implement font-display: swap for perceived performance

---

## 3. Spacings

### Golden Ratio Scale (1.618)
The spacing system follows the golden ratio for natural, harmonious rhythm:

- **xs**: 5px - Minimal spacing for tight groupings
- **sm**: 8px - Base unit, internal component padding
- **md**: 13px - Standard gap between related elements
- **lg**: 21px - Section spacing, button padding
- **xl**: 34px - Major section breaks, card padding
- **2xl**: 55px - Page sections, hero spacing
- **3xl**: 89px - Maximum spacing for dramatic separation

### Application Guidelines

**Component Interior**
- Use `sm` (8px) for internal padding in compact elements
- Use `md` (13px) for standard button/input padding
- Use `lg` (21px) for card and container padding

**Element Relationships**
- Use `xs` (5px) between tightly coupled elements (icon + label)
- Use `sm` (8px) between related items in a group
- Use `md` (13px) as default gap in flex/grid layouts
- Use `lg` (21px) between distinct groups within a section

**Section Hierarchy**
- Use `xl` (34px) between major content sections
- Use `2xl` (55px) for page-level section breaks
- Use `3xl` (89px) for hero sections and dramatic emphasis

**Responsive Behavior**
- Spacing scales proportionally with viewport
- Maintain golden ratio relationships across breakpoints
- Never reduce below minimum touch target requirements (44px)

---

## 4. Colors

### Primary Colors

**Deep Charcoal** (#15151F)
- Primary brand color for headings and strong emphasis
- Maximum contrast for critical text
- Conveys sophistication and authority

**Emerald Accent** (#047857)
- Distinctive accent for CTAs and active states
- Sparingly used for maximum impact
- Creates unique identity among AI tools

### Neutral Scale (Perceptually Uniform)

**Off-White** (#F8F9FA)
- Primary background, reduces blue light by 40%
- Softer than pure white for extended viewing comfort
- Creates warm, approachable atmosphere

**Pure White** (#FFFFFF)
- Reserved for cards and elevated surfaces
- Creates depth through contrast with off-white background
- Used for maximum emphasis areas

**Gray 50** (#F5F6F5)
- Subtle background tints
- Hover states for light surfaces
- Minimal visual separation

**Gray 100** (#E7E8E6)
- Light borders and dividers
- Secondary backgrounds
- Skeleton loading base

**Gray 200** (#D0D1CE)
- Standard borders
- Disabled state backgrounds
- Medium visual separation

**Gray 300** (#A9A9A3)
- Inactive elements
- Subtle icons
- Placeholder text

**Gray 400** (#79796F)
- Secondary text
- Inactive navigation
- Form placeholders

**Gray 500** (#5B5B52)
- Mid-tone for balanced elements
- Section labels
- Metadata

**Gray 600** (#434339)
- Body text secondary
- Captions and descriptions
- Warm neutral tone

**Gray 700** (#2F2F27)
- Strong emphasis text
- Active navigation
- Important labels

**Gray 800** (#20201A)
- Primary body text
- High readability
- Warm dark tone

**Gray 900** (#15151F)
- Headings and maximum emphasis
- Primary UI elements
- Near-black with warmth

**Soft Black** (#1A1A23)
- Softer alternative to pure black
- Reduced eye strain for text
- Terminal/code backgrounds

### Accent Shades

**Emerald Light** (#059669)
- Hover states for accent elements
- Secondary success indicators

**Emerald Lighter** (#10B981)
- Success messages
- Positive feedback

**Emerald Dark** (#064E3B)
- Pressed states for accent buttons
- Deep emphasis

**Emerald Glow** (rgba(16, 185, 129, 0.08))
- Subtle background tints
- Focus glows
- Active state backgrounds

### Semantic Colors

**Success** (#059669)
- Positive actions and confirmations
- Muted to avoid distraction

**Warning** (#D97706)
- Caution states and alerts
- Warm tone for approachability

**Error** (#DC2626)
- Error states and critical actions
- Clear but not alarming

**Info** (#0284C7)
- Informational messages
- Neutral and professional

### Color Application Rules
- Always maintain 4.5:1 contrast ratio for text
- Use emerald accent sparingly (10% rule)
- Implement color through CSS variables for theming
- Test all colors for color-blind accessibility
- Never use pure black or white for extended reading

<!-- -------------- -->

# Piano Design System - Additions to Original Document

## Core Updates to Original Document

### Section: Colors

**Add after "Primary Colors":**

#### Monochrome-First Philosophy
- 90% of interface uses grayscale palette
- 10% strategic color for meaningful states only
- Color appears only for: AI processing states, success/error feedback, primary CTAs
- No decorative color usage

#### Functional State Colors
- **Thinking Blue** (#4B93F6) - AI processing state
- **Success Green** (#10B981) - Completion state  
- **Error Red** (#DC2626) - Error state
- **Warning Amber** (#F59E0B) - Caution/alert state
- **Emerald Accent** (#047857) - Primary CTA only

### Section: Typography

**Add after "Font Sizes":**

#### Variable Font Settings
- **Optical Sizing**: 
  - Display (>32px): opsz:32
  - Text (16-32px): opsz:20  
  - Caption (<16px): opsz:12
- **Weight Adjustments**:
  - Short headlines (<20 chars): wght:700
  - Long headlines (>20 chars): wght:600
  - Body text: wght:400-450

### New Section After Colors:

## 5. Elevation System

Light theme elevation through subtle shadows and borders:

**Standard Elevation:**
- Level 0 (Background): #F8F9FA
- Level 1 (Cards): #FFFFFF with 1px border #E7E8E6
- Level 2 (Raised): #FFFFFF with 1px border #D0D1CE
- Level 3 (Active): #FFFFFF with 1.5px border #047857

Use borders and white backgrounds for elevation. No gradient shadows.

### New Section:

## 6. Interaction Principles

#### Hover States
- Color changes only (10% darker or accent color)
- No scale transforms
- No position changes
- No animation/movement
- Transition: 150ms ease-in-out

#### Focus States
- 2px solid outline in accent color
- 2px offset from element
- No glow effects

#### Click States
- Background color 15% darker
- No scale changes
- Instant feedback (<50ms)

### New Section:

## 7. Layout Principles

#### Grid System
- Strict 8px base grid
- Components snap to grid precisely
- No random offsets or rotations
- Consistent alignment across all elements
- 16px minimum spacing between unrelated elements

#### Card Layout
- All cards same height in rows
- Consistent padding: 16px mobile, 24px desktop
- 1px border, no shadows
- White background on light gray canvas

### Update "Color Application Rules":

**Replace with:**
- Minimum 4.5:1 contrast ratio
- Grayscale for 90% of UI
- Accent colors only for interactive elements and status
- No pure black (#000) - use #1A1A23
- No pure white for backgrounds - use #F8F9FA

### Add Section:

## 8. Animation Guidelines

#### Permitted Animations
- Opacity fades: 150-200ms
- Color transitions: 150ms  
- Page transitions: 250ms fade only

#### Prohibited Animations
- Spring/bounce effects
- Scale transforms on hover
- Position shifts on hover
- "Breathing" or ambient motion
- Parallax effects
- Auto-playing animations

### Add Section:

## 9. Texture & Visual Effects

#### Textures
- If used, minimum 8% opacity for visibility
- Only on decorative elements, never on functional UI
- Static only, no animated textures

#### Gradients
- Single direction only (top-to-bottom or left-to-right)
- Maximum 10% color variance
- No mesh gradients in MVP
- Use solid colors for functional elements

### Final Section:

## 10. Implementation Priorities

**Phase 1 - Core UI (Week 1)**
- Grayscale color system
- Typography scale
- Grid layout system
- Basic components (buttons, cards, inputs)

**Phase 2 - Functionality (Week 2)**  
- State colors (thinking, success, error)
- Form validation
- Focus/hover states
- Responsive grid

**Phase 3 - Polish (Week 3)**
- Micro-interactions (color transitions only)
- Loading states (border color animation)
- Error handling UI

**Do Not Implement in MVP:**
- Animations beyond simple fades
- Decorative textures
- Complex gradients
- Custom positioning systems
- Ambient motion of any kind