# Adobe Spectrum Interface Builder Prompt Template
## For AEM-Aligned Applications (Claude Code / Lovable)

Use this template when building any AEM-related interface to ensure perfect alignment with Adobe's Spectrum Design System.

---

## 🎯 Core Project Brief

**Project Type**: [Dashboard / Admin Panel / Content Editor / Analytics Interface / Workflow Tool / etc.]

**Primary Purpose**: [Brief 1-2 sentence description of what this interface does]

**Target Users**: [Content authors / Developers / Marketing teams / Administrators / etc.]

**Integration Context**: [Standalone tool / AEM integration / EDS companion / etc.]

---

## 🎨 Spectrum Implementation Configuration

### Framework Choice
Select ONE based on your stack:

- **For React projects (Lovable, Next.js, Create React App)**:
  ```
  USE: swc-react (Spectrum Web Components React wrappers)
  INSTALL: @swc-react/[component-name]
  DOCS: https://opensource.adobe.com/spectrum-web-components/
  ```

- **For Vanilla JS / Framework-agnostic (Claude Code)**:
  ```
  USE: Spectrum Web Components (native web components)
  INSTALL: @spectrum-web-components/[component-name]
  DOCS: https://opensource.adobe.com/spectrum-web-components/
  ```

- **For Simple Styling Only (not recommended)**:
  ```
  USE: Spectrum CSS (no interactivity)
  INSTALL: @spectrum-css/[component-name]
  NOTE: Only for basic typography, forms - lacks event handling
  ```

### Theme Configuration

```jsx
// For swc-react (React)
import { Theme } from '@swc-react/theme';

<Theme theme="express" scale="medium" color="light">
  {/* Your application components */}
</Theme>

// For Spectrum Web Components (Vanilla)
<sp-theme theme="express" scale="medium" color="light">
  <!-- Your application components -->
</sp-theme>
```

**Theme Options**:
- `theme`: "express" | "spectrum" (use "express" for modern Adobe feel)
- `scale`: "medium" | "large" (use "medium" for desktop, "large" for accessibility)
- `color`: "light" | "dark" (support both for user preference)

---

## 📚 Essential Resources & Documentation

### CRITICAL: Provide these URLs in your prompt

```
PRIMARY DOCUMENTATION:
- Spectrum Homepage: https://spectrum.adobe.com/
- Component Library: https://opensource.adobe.com/spectrum-web-components/
- Implementation Guide: https://developer.adobe.com/express/add-ons/docs/guides/build/design/implementation_guide/
- Design Guidelines: https://spectrum.adobe.com/page/[component-name]/

DESIGN TOKENS & THEMING:
- Token Visualizer (S2): https://opensource.adobe.com/spectrum-tokens/s2-visualizer/
- Token Docs: https://github.com/adobe/spectrum-tokens
- Spectrum CSS: https://github.com/adobe/spectrum-css

SPECTRUM 2 UPDATES:
- What's New: https://blog.adobe.com/en/publish/2023/12/12/adobe-unveils-spectrum-2-design-system-reimagining-user-experience-over-100-adobe-applications
- Design Site: https://s2.spectrum.adobe.com/

FOR COMPLEX INTEGRATIONS:
- React Spectrum: https://react-spectrum.adobe.com/react-spectrum/
- React Aria (headless): https://react-spectrum.adobe.com/react-aria/
```

### 🔌 Optional: MCP Server Integration (Advanced)

For Claude Code with enhanced Spectrum knowledge:

```json
// In Claude Desktop config
{
  "mcpServers": {
    "adobe-express": {
      "command": "npx",
      "args": ["-y", "adobe-express-mcp-server"]
    }
  }
}
```

This provides real-time access to Spectrum Web Components documentation and Adobe design patterns.

---

## 🏗️ Component Architecture Guide

### Layout Components (Foundation)

```jsx
CORE STRUCTURE:
- Theme Provider (wrapper for entire app)
- Grid / Flex (layout primitives)
- Divider (section separation)
- Well / Tray (content containers)

EXAMPLE:
import { Grid, Flex, Divider } from '@swc-react/[components]';

<Grid areas={['header', 'main', 'sidebar', 'footer']}>
  <Flex direction="column" gap="size-200">
    {/* Content */}
  </Flex>
</Grid>
```

### Navigation Components

```jsx
COMMON PATTERNS:
- ActionBar (primary actions)
- ActionButton (individual actions)
- Menu (dropdowns, context menus)
- Tabs (section navigation)
- Breadcrumbs (hierarchical navigation)
- SideNav (drawer navigation)

FOR AEM INTERFACES:
- Use ActionBar for primary operations (Save, Publish, Preview)
- Menu for secondary actions (Export, Settings, Share)
- Breadcrumbs for content hierarchy (Sites > Products > Category)
```

### Data Display Components

```jsx
DATA VISUALIZATION:
- Table (data grids - sortable, filterable)
- Card / CardView (content cards)
- ListView (lists with actions)
- BarChart / AreaChart / DonutChart (analytics)
- BigNumber (key metrics)

DATA ENTRY:
- TextField / TextArea (text input)
- Picker / ComboBox (dropdowns with search)
- Checkbox / CheckboxGroup (multi-select)
- Radio / RadioGroup (single-select)
- Switch (binary toggle)
- Slider (range input)
- DatePicker / DateRangePicker (dates)

FEEDBACK:
- ProgressBar / ProgressCircle (loading states)
- Toast (notifications)
- Dialog / AlertDialog (modals)
- StatusLight (status indicators)
- Badge (counts, labels)
```

### Action Components

```jsx
BUTTONS:
- Button (primary, secondary, negative actions)
- ActionButton (icon + label actions)
- ClearButton (dismiss/clear actions)
- ToggleButton (on/off states)

QUICK ACTIONS:
- QuickActions (contextual mini-toolbar)
- ActionGroup (related actions)
```

---

## 🎯 AEM-Specific Interface Patterns

### Document Authoring Integration

```jsx
// Content block management interface
COMPONENTS NEEDED:
- Drag-and-drop areas (use DragDrop utilities)
- Block library (CardView with search)
- Properties panel (Form with TextField, Picker, Checkbox)
- Preview toggle (ActionButton with icon)

LAYOUT:
[Block Library Sidebar] [Main Canvas] [Properties Panel]
```

### Content Migration Dashboard

```jsx
// Analytics and progress tracking
COMPONENTS NEEDED:
- KPI cards (BigNumber + BarChart)
- Progress indicators (ProgressBar)
- Data tables (Table with sorting/filtering)
- Action toolbar (ActionBar)
- Status indicators (StatusLight, Badge)

LAYOUT:
[Header with ActionBar]
[KPIs in Grid]
[Migration Progress Table]
[Details Panel]
```

### Site Configuration Interface

```jsx
// Settings and preferences
COMPONENTS NEEDED:
- Tabbed navigation (Tabs)
- Form sections (Well + Form)
- Action buttons (Button variants)
- Help text (HelpText, TooltipTrigger)

LAYOUT:
[Tabs for sections]
[Form fields in columns]
[Action bar sticky footer]
```

### Asset Management

```jsx
// Media library and DAM
COMPONENTS NEEDED:
- Grid/List view toggle (ActionButton group)
- Search and filters (SearchField, Picker)
- Asset cards (Card with QuickActions)
- Bulk operations (ActionBar when selected)

LAYOUT:
[Search bar + View toggles]
[Filter sidebar] [Asset grid/list] [Inspector panel]
```

---

## 🎨 Design Token Usage

### Spacing System

```css
/* Use Spectrum spacing tokens for consistency */
--spectrum-spacing-size-50   /* 4px */
--spectrum-spacing-size-100  /* 8px */
--spectrum-spacing-size-200  /* 16px */
--spectrum-spacing-size-300  /* 24px */
--spectrum-spacing-size-400  /* 32px */
--spectrum-spacing-size-500  /* 40px */

/* In components */
padding: var(--spectrum-spacing-size-200);
gap: var(--spectrum-spacing-size-100);
```

### Color System

```css
/* Never hardcode colors - use semantic tokens */
--spectrum-accent-color-900        /* Primary brand */
--spectrum-neutral-background-color-default
--spectrum-neutral-content-color-default
--spectrum-positive-color-900      /* Success */
--spectrum-negative-color-900      /* Error */
--spectrum-informative-color-900   /* Info */
--spectrum-notice-color-900        /* Warning */

/* Example */
background: var(--spectrum-neutral-background-color-default);
color: var(--spectrum-neutral-content-color-default);
```

### Typography

```css
/* Use Spectrum typography tokens */
--spectrum-heading-size-xl
--spectrum-heading-size-l
--spectrum-body-size-l
--spectrum-body-size-m
--spectrum-body-size-s
--spectrum-detail-size-s

/* Never use custom fonts - Adobe Clean is provided */
font-family: var(--spectrum-sans-font-family);
```

### Component Modifiers

```css
/* Use --mod-* properties to customize components */
--mod-button-background-color
--mod-textfield-border-color
--mod-actionbutton-icon-color

/* Example: Custom button variant */
.custom-cta-button {
  --mod-button-background-color: var(--spectrum-accent-color-1000);
  --mod-button-content-color: white;
}
```

---

## ♿ Accessibility Requirements

### Built-in Standards

All Spectrum components include:
- ✅ ARIA attributes
- ✅ Keyboard navigation
- ✅ Screen reader support
- ✅ Focus management
- ✅ Color contrast compliance

### Additional Requirements

```jsx
// Always provide labels
<TextField label="Site Name" isRequired />

// Use aria-label for icon-only actions
<ActionButton aria-label="Delete item">
  <Delete />
</ActionButton>

// Provide helpful errors
<TextField 
  label="URL" 
  validationState={isInvalid ? "invalid" : "valid"}
  errorMessage="Please enter a valid URL"
/>

// Support keyboard shortcuts
<ActionButton onKeyDown={handleShortcut}>
  Save (⌘S)
</ActionButton>
```

---

## 📱 Responsive Design Patterns

### Mobile-First Approach

```jsx
// Spectrum automatically handles responsive scaling
// But consider these patterns:

// Hide secondary actions on mobile
<ActionBar UNSAFE_className="hide-mobile">
  <ActionButton>Secondary Action</ActionButton>
</ActionBar>

// Stack layouts vertically on small screens
<Grid 
  areas={isMobile ? ['header', 'content'] : ['header header', 'sidebar content']}
  columns={isMobile ? ['1fr'] : ['200px', '1fr']}
>
```

### Adaptive Components

```jsx
// Use Spectrum's built-in responsive behavior
// Components auto-adjust based on:
// - Scale (medium/large)
// - Color scheme (light/dark)
// - Viewport size
// - Touch vs mouse input
```

---

## ⚡ Performance Best Practices

### Code Splitting

```jsx
// Load components on-demand
const Dialog = lazy(() => import('@swc-react/dialog'));

// Load heavy components conditionally
{showAnalytics && <AnalyticsDashboard />}
```

### Token Optimization

```jsx
// Import only needed token sets
import '@spectrum-css/tokens/dist/index.css'; // All tokens
// OR
import '@spectrum-css/tokens/dist/spectrum-global.css'; // Just globals
```

### Bundle Size

```bash
# Install only components you use
npm install @swc-react/button @swc-react/textfield
# NOT: npm install @swc-react/* (installs everything)
```

---

## 🔒 Content Governance Integration

### Pre-approved Asset Libraries

```jsx
// When building for enterprise AEM
// Integrate with approved content repositories

import { AssetPicker } from './aem-components';

// Only show approved brand assets
<AssetPicker 
  repository="wknd-approved"
  categories={["logos", "product-images", "templates"]}
  onSelect={handleAssetSelect}
/>
```

### Workflow State Management

```jsx
// Track content state with StatusLight
<StatusLight variant="positive">Published</StatusLight>
<StatusLight variant="notice">Draft</StatusLight>
<StatusLight variant="negative">Rejected</StatusLight>
<StatusLight variant="info">In Review</StatusLight>
```

---

## 📊 Common AEM Interface Recipes

### Recipe 1: Content Import Dashboard

```jsx
import { 
  ActionBar, ActionButton, 
  Table, TableView, 
  ProgressBar, 
  StatusLight, 
  Badge 
} from '@swc-react/[components]';

function ImportDashboard() {
  return (
    <div className="import-dashboard">
      <ActionBar>
        <ActionButton>Start Import</ActionButton>
        <ActionButton>View Logs</ActionButton>
        <ActionButton isQuiet>Settings</ActionButton>
      </ActionBar>
      
      <div className="metrics-grid">
        <MetricCard 
          label="Pages Imported" 
          value={324} 
          trend="+12%"
        />
        <MetricCard 
          label="Blocks Created" 
          value={1243} 
          trend="+8%"
        />
      </div>
      
      <TableView aria-label="Import queue">
        <TableHeader>
          <Column>Page</Column>
          <Column>Status</Column>
          <Column>Progress</Column>
          <Column>Actions</Column>
        </TableHeader>
        <TableBody>
          <Row>
            <Cell>/products/camera</Cell>
            <Cell><StatusLight variant="positive">Complete</StatusLight></Cell>
            <Cell><ProgressBar value={100} /></Cell>
            <Cell><ActionButton>View</ActionButton></Cell>
          </Row>
        </TableBody>
      </TableView>
    </div>
  );
}
```

### Recipe 2: Block Configuration Panel

```jsx
import { 
  Tabs, TabList, TabPanels, Item,
  TextField, Picker, Checkbox,
  Well, Form,
  Button
} from '@swc-react/[components]';

function BlockConfigurator({ blockType, onSave }) {
  return (
    <Tabs>
      <TabList>
        <Item key="content">Content</Item>
        <Item key="style">Style</Item>
        <Item key="advanced">Advanced</Item>
      </TabList>
      
      <TabPanels>
        <Item key="content">
          <Form>
            <TextField label="Heading" />
            <TextField label="Body" multiline />
            <Picker label="Layout">
              <Item>Single Column</Item>
              <Item>Two Column</Item>
              <Item>Grid</Item>
            </Picker>
          </Form>
        </Item>
        
        <Item key="style">
          <Well>
            <Checkbox>Enable dark mode</Checkbox>
            <Checkbox>Full-width background</Checkbox>
            <Picker label="Spacing">
              <Item>Compact</Item>
              <Item>Default</Item>
              <Item>Relaxed</Item>
            </Picker>
          </Well>
        </Item>
        
        <Item key="advanced">
          <Form>
            <TextField label="CSS Classes" />
            <TextField label="Custom Attributes" multiline />
          </Form>
        </Item>
      </TabPanels>
      
      <ActionBar>
        <Button variant="secondary">Cancel</Button>
        <Button variant="cta" onPress={onSave}>Save Block</Button>
      </ActionBar>
    </Tabs>
  );
}
```

### Recipe 3: Site Analytics Overview

```jsx
import { 
  Grid, Flex,
  BarChart, AreaChart, BigNumber,
  Card, CardView,
  DateRangePicker,
  ActionButton
} from '@swc-react/[components]';

function AnalyticsDashboard() {
  return (
    <div className="analytics-dashboard">
      <Flex justifyContent="space-between" marginBottom="size-300">
        <h1>Site Performance</h1>
        <Flex gap="size-100">
          <DateRangePicker />
          <ActionButton>Export Report</ActionButton>
        </Flex>
      </Flex>
      
      <Grid columns={['1fr', '1fr', '1fr']} gap="size-200">
        <Card>
          <BigNumber 
            value={2847}
            label="Page Views"
            variant="positive"
            change="+23%"
          />
        </Card>
        <Card>
          <BigNumber 
            value={0.92}
            label="Core Web Vitals"
            variant="positive"
            change="+0.12"
          />
        </Card>
        <Card>
          <BigNumber 
            value={12.4}
            label="Avg Load Time (s)"
            variant="negative"
            change="-1.2s"
          />
        </Card>
      </Grid>
      
      <Card marginTop="size-300">
        <h2>Traffic Trends</h2>
        <AreaChart 
          data={trafficData}
          xAccessor="date"
          yAccessor="visits"
        />
      </Card>
      
      <Card marginTop="size-300">
        <h2>Top Pages</h2>
        <BarChart 
          data={pageData}
          xAccessor="page"
          yAccessor="views"
        />
      </Card>
    </div>
  );
}
```

---

## 🚀 Getting Started Checklist

When starting your project, provide this checklist to the AI:

```markdown
## Project Setup Checklist

- [ ] Identify framework (React vs Vanilla JS)
- [ ] Choose Spectrum implementation (swc-react vs SWC vs Spectrum CSS)
- [ ] Set up Theme provider with correct scale/color
- [ ] Install required component packages
- [ ] Import design tokens
- [ ] Configure dark mode support (if needed)
- [ ] Set up responsive breakpoints
- [ ] Plan component hierarchy
- [ ] Identify all required Spectrum components
- [ ] Map data flows to components
- [ ] Define custom --mod-* overrides (if needed)
- [ ] Implement accessibility requirements
- [ ] Test keyboard navigation
- [ ] Test screen reader compatibility
- [ ] Optimize bundle size
- [ ] Document component usage patterns
```

---

## 🎓 Example Prompt for Claude Code / Lovable

```
I'm building a [PROJECT TYPE] for Adobe Experience Manager using React and Lovable.

FRAMEWORK: React 18+ with TypeScript
DESIGN SYSTEM: Adobe Spectrum 2 (swc-react implementation)
THEME: Express, medium scale, light mode (with dark mode support)

INTERFACE REQUIREMENTS:
- [Describe the interface - e.g., "Content migration dashboard"]
- [Key features - e.g., "Real-time progress tracking"]
- [User workflows - e.g., "Start import, monitor progress, view results"]

REQUIRED COMPONENTS:
Based on the interface, I need these Spectrum components:
- Layout: Theme, Grid, Flex, Divider
- Navigation: ActionBar, Tabs, Breadcrumbs
- Data: Table, ProgressBar, StatusLight
- Actions: Button, ActionButton, Menu
- Forms: TextField, Picker, Checkbox
- Feedback: Toast, Dialog

DESIGN REQUIREMENTS:
- Use Spectrum design tokens for ALL spacing, colors, typography
- Implement responsive design (mobile-first)
- Support both light and dark themes
- Maintain AAA accessibility standards
- Use only approved Spectrum components (no custom UI)

DOCUMENTATION REFERENCES:
- Component docs: https://opensource.adobe.com/spectrum-web-components/
- Token visualizer: https://opensource.adobe.com/spectrum-tokens/s2-visualizer/
- Implementation guide: https://developer.adobe.com/express/add-ons/docs/guides/build/design/implementation_guide/

AEM INTEGRATION CONTEXT:
- This interfaces with AEM Edge Delivery Services
- Users are [content authors / developers / admins]
- Data comes from [Document Authoring / SharePoint / etc.]
- Must align with Adobe brand guidelines

Please:
1. Set up the project structure with Spectrum theme provider
2. Create the main layout using Spectrum Grid/Flex
3. Implement each interface section with appropriate Spectrum components
4. Use design tokens for all styling (no hardcoded values)
5. Ensure full keyboard navigation and ARIA compliance
6. Make it responsive (mobile, tablet, desktop)
7. Provide inline comments explaining Spectrum patterns used

OUTPUT FORMAT:
- Complete, runnable code
- Organized component hierarchy
- Proper TypeScript types
- Accessibility attributes
- Responsive CSS using Spectrum tokens
```

---

## 🔗 Quick Reference Links

**Official Documentation**:
- Spectrum Homepage: https://spectrum.adobe.com/
- SWC Docs: https://opensource.adobe.com/spectrum-web-components/
- React Spectrum: https://react-spectrum.adobe.com/

**Tools & Visualizers**:
- Token Visualizer: https://opensource.adobe.com/spectrum-tokens/s2-visualizer/
- Component Explorer: https://opensource.adobe.com/spectrum-web-components/storybook/

**Learning Resources**:
- Getting Started: https://developer.adobe.com/express/add-ons/docs/guides/tutorials/spectrum-workshop/
- Implementation Guide: https://developer.adobe.com/express/add-ons/docs/guides/build/design/implementation_guide/

**GitHub Repos**:
- Tokens: https://github.com/adobe/spectrum-tokens
- Web Components: https://github.com/adobe/spectrum-web-components
- React Spectrum: https://github.com/adobe/react-spectrum
- Spectrum CSS: https://github.com/adobe/spectrum-css

**Community**:
- Figma Kit: https://www.figma.com/community/file/1211274196563394418/adobe-spectrum-design-system
- Spectrum Blog: https://blog.adobe.com/ (search "Spectrum")

---

## 💡 Pro Tips

1. **Always use design tokens** - Never hardcode spacing, colors, or typography
2. **Start with the Theme** - Wrap your entire app in Theme/sp-theme first
3. **Import selectively** - Only install components you actually use
4. **Follow the visual hierarchy** - Spectrum has built-in patterns (headers, actions, content)
5. **Test accessibility early** - Use keyboard-only navigation during development
6. **Respect component APIs** - Don't fight against Spectrum patterns
7. **Use --mod-* sparingly** - Only customize when absolutely necessary
8. **Support dark mode** - It's a simple theme prop, users expect it
9. **Leverage StatusLight** - Perfect for workflow states in AEM interfaces
10. **ActionBar is your friend** - Primary actions belong in the ActionBar

---

## 📝 Notes

- Spectrum 2 is the current version (launched late 2023)
- swc-react is more actively maintained than React Spectrum for most use cases
- All Spectrum components are designed mobile-first
- Adobe Clean font is included automatically via tokens
- Components automatically adapt to theme changes
- Accessibility is built-in, not an afterthought
- Spectrum CSS alone lacks interactivity - use SWC or swc-react for full features

---

**VERSION**: 1.0 (November 2025)
**SPECTRUM VERSION**: 2.x
**LAST UPDATED**: Aligned with latest SWC and Spectrum 2 documentation
