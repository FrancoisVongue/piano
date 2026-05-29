/**
 * Layout Utilities
 * 
 * Pure functions for calculating node positions in a canvas.
 * These utilities provide consistent, predictable layouts for multiple children.
 */

export namespace Layout {
  // ============================================
  // TYPES
  // ============================================

  export interface Position {
    x: number;
    y: number;
  }

  export type LayoutStyle = 'HORIZONTAL' | 'VERTICAL' | 'GRID';

  export interface LayoutConfig {
    parentPosition: Position;
    childCount: number;
    style?: LayoutStyle;
    spacing?: {
      x?: number;
      y?: number;
    };
  }

  // ============================================
  // CONSTANTS (Sensible Defaults)
  // ============================================

  export const DEFAULT_SPACING = {
    HORIZONTAL: { x: 300, y: 0 },
    VERTICAL: { x: 0, y: 200 },
    GRID: { x: 300, y: 200 },
  };

  export const DEFAULT_OFFSET = { x: 0, y: 250 }; // Offset from parent

  // ============================================
  // PURE LAYOUT FUNCTIONS
  // ============================================

  /**
   * Calculates positions for multiple child nodes in a horizontal line
   * 
   * @example
   * // Parent at (100, 100), 3 children, spacing 300px apart
   * calculateHorizontalLayout({ x: 100, y: 100 }, 3, { x: 300, y: 0 })
   * // Returns: [{ x: -200, y: 350 }, { x: 100, y: 350 }, { x: 400, y: 350 }]
   * //          (Left)               (Center)           (Right)
   */
  export const calculateHorizontalLayout = (
    parentPosition: Position,
    childCount: number,
    spacing: Position = DEFAULT_SPACING.HORIZONTAL
  ): Position[] => {
    if (childCount === 0) return [];
    if (childCount === 1) {
      return [{
        x: parentPosition.x,
        y: parentPosition.y + DEFAULT_OFFSET.y,
      }];
    }

    // Calculate total width needed
    const totalWidth = (childCount - 1) * spacing.x;
    
    // Start position (left-most child)
    const startX = parentPosition.x - totalWidth / 2;
    const y = parentPosition.y + DEFAULT_OFFSET.y;

    // Generate positions for each child
    return Array.from({ length: childCount }, (_, index) => ({
      x: startX + index * spacing.x,
      y,
    }));
  };

  /**
   * Calculates positions for multiple child nodes in a vertical line
   */
  export const calculateVerticalLayout = (
    parentPosition: Position,
    childCount: number,
    spacing: Position = DEFAULT_SPACING.VERTICAL
  ): Position[] => {
    if (childCount === 0) return [];

    const x = parentPosition.x;
    const startY = parentPosition.y + DEFAULT_OFFSET.y;

    return Array.from({ length: childCount }, (_, index) => ({
      x,
      y: startY + index * spacing.y,
    }));
  };

  /**
   * Calculates positions for multiple child nodes in a grid layout
   * Useful for many children (e.g., 10+ items)
   */
  export const calculateGridLayout = (
    parentPosition: Position,
    childCount: number,
    spacing: Position = DEFAULT_SPACING.GRID,
    columns: number = 3 // Default 3 columns
  ): Position[] => {
    if (childCount === 0) return [];

    const rows = Math.ceil(childCount / columns);
    const totalWidth = (columns - 1) * spacing.x;
    const startX = parentPosition.x - totalWidth / 2;
    const startY = parentPosition.y + DEFAULT_OFFSET.y;

    return Array.from({ length: childCount }, (_, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      
      return {
        x: startX + col * spacing.x,
        y: startY + row * spacing.y,
      };
    });
  };

  /**
   * Main layout calculation function - dispatches to appropriate layout style
   * 
   * @example
   * calculateChildPositions({
   *   parentPosition: { x: 100, y: 100 },
   *   childCount: 5,
   *   style: 'HORIZONTAL',
   *   spacing: { x: 250 }
   * })
   */
  export const calculateChildPositions = (config: LayoutConfig): Position[] => {
    const {
      parentPosition,
      childCount,
      style = 'HORIZONTAL',
      spacing,
    } = config;

    // Merge custom spacing with defaults
    const finalSpacing = {
      ...DEFAULT_SPACING[style],
      ...spacing,
    };

    switch (style) {
      case 'HORIZONTAL':
        return calculateHorizontalLayout(parentPosition, childCount, finalSpacing);
      
      case 'VERTICAL':
        return calculateVerticalLayout(parentPosition, childCount, finalSpacing);
      
      case 'GRID':
        // Auto-switch to grid for many children (better UX)
        const columns = childCount > 9 ? 4 : 3;
        return calculateGridLayout(parentPosition, childCount, finalSpacing, columns);
      
      default:
        return calculateHorizontalLayout(parentPosition, childCount, finalSpacing);
    }
  };

  /**
   * Smart layout selector - chooses the best layout style based on child count
   * 
   * - 1-3 children: Horizontal
   * - 4-6 children: Horizontal with wider spacing
   * - 7+ children: Grid layout
   */
  export const calculateSmartLayout = (
    parentPosition: Position,
    childCount: number
  ): Position[] => {
    if (childCount <= 3) {
      return calculateChildPositions({
        parentPosition,
        childCount,
        style: 'HORIZONTAL',
      });
    } else if (childCount <= 6) {
      return calculateChildPositions({
        parentPosition,
        childCount,
        style: 'HORIZONTAL',
        spacing: { x: 350 }, // Wider spacing for more children
      });
    } else {
      return calculateChildPositions({
        parentPosition,
        childCount,
        style: 'GRID',
      });
    }
  };
}
