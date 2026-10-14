/**
 * Operator Behavior Documentation
 *
 * This file documents the consistent behavior of operators across the entire application.
 * These operators are used in:
 * - Segment filtering (SegmentService)
 * - Workflow CONDITION steps (WorkflowExecutionService)
 *
 * IMPORTANT: Both implementations MUST behave identically for consistency.
 */

/**
 * All supported operators
 */
export const OPERATORS = {
  // String operators
  EQUALS: 'equals',
  NOT_EQUALS: 'notEquals',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'notContains',

  // Numeric operators
  GREATER_THAN: 'greaterThan',
  LESS_THAN: 'lessThan',
  GREATER_THAN_OR_EQUAL: 'greaterThanOrEqual',
  LESS_THAN_OR_EQUAL: 'lessThanOrEqual',

  // Existence operators
  EXISTS: 'exists',
  NOT_EXISTS: 'notExists',

  // Temporal operators (segments only)
  WITHIN: 'within',

  // Array operators (segments only, custom data fields; fork D31)
  INCLUDES_ANY: 'includesAny',
  INCLUDES_ALL: 'includesAll',
  INCLUDES_NONE: 'includesNone',
} as const;

/**
 * Operators available for segments
 */
export const SEGMENT_OPERATORS = [
  OPERATORS.EQUALS,
  OPERATORS.NOT_EQUALS,
  OPERATORS.CONTAINS,
  OPERATORS.NOT_CONTAINS,
  OPERATORS.GREATER_THAN,
  OPERATORS.LESS_THAN,
  OPERATORS.GREATER_THAN_OR_EQUAL,
  OPERATORS.LESS_THAN_OR_EQUAL,
  OPERATORS.EXISTS,
  OPERATORS.NOT_EXISTS,
  OPERATORS.WITHIN,
  OPERATORS.INCLUDES_ANY,
  OPERATORS.INCLUDES_ALL,
  OPERATORS.INCLUDES_NONE,
] as const;

/**
 * Operators available for workflow conditions
 * Note: 'within' is NOT supported in workflow conditions
 */
export const WORKFLOW_CONDITION_OPERATORS = [
  OPERATORS.EQUALS,
  OPERATORS.NOT_EQUALS,
  OPERATORS.CONTAINS,
  OPERATORS.NOT_CONTAINS,
  OPERATORS.GREATER_THAN,
  OPERATORS.LESS_THAN,
  OPERATORS.GREATER_THAN_OR_EQUAL,
  OPERATORS.LESS_THAN_OR_EQUAL,
  OPERATORS.EXISTS,
  OPERATORS.NOT_EXISTS,
] as const;

/**
 * Operator Behavior Rules
 *
 * CRITICAL: These rules apply to BOTH SegmentService and WorkflowExecutionService
 *
 * 1. EQUALS (=)
 *    - Matches when actualValue === expectedValue
 *    - CAN match null/undefined if expectedValue is also null/undefined
 *    - String fields: case-insensitive (email)
 *    - Boolean fields: strict comparison
 *
 * 2. NOT_EQUALS (≠)
 *    - ONLY matches when field EXISTS and actualValue !== expectedValue
 *    - Does NOT match missing fields (undefined/null)
 *    - Use notExists operator if you want to find missing fields
 *    - Use OR[notEquals, notExists] if you want both
 *
 * 3. CONTAINS (substring)
 *    - ONLY matches when field EXISTS and contains substring
 *    - Does NOT match missing fields (undefined/null)
 *    - String fields: case-insensitive (email)
 *    - Converts values to strings before comparison
 *
 * 4. NOT_CONTAINS (not substring)
 *    - ONLY matches when field EXISTS and does NOT contain substring
 *    - Does NOT match missing fields (undefined/null)
 *    - Use notExists operator if you want to find missing fields
 *    - Use OR[notContains, notExists] if you want both
 *
 * 5. GREATER_THAN (>)
 *    - ONLY matches when field EXISTS and Number(actualValue) > Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 6. LESS_THAN (<)
 *    - ONLY matches when field EXISTS and Number(actualValue) < Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 7. GREATER_THAN_OR_EQUAL (≥)
 *    - ONLY matches when field EXISTS and Number(actualValue) >= Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 8. LESS_THAN_OR_EQUAL (≤)
 *    - ONLY matches when field EXISTS and Number(actualValue) <= Number(expectedValue)
 *    - Does NOT match missing fields (undefined/null)
 *    - Converts values to numbers before comparison
 *
 * 9. EXISTS
 *    - Matches when actualValue !== undefined && actualValue !== null
 *    - Matches empty strings, zero, false (these are valid existing values)
 *
 * 10. NOT_EXISTS
 *     - Matches when actualValue === undefined || actualValue === null
 *     - Does NOT match empty strings, zero, or false
 *
 * 11. WITHIN (temporal - segments only)
 *     - Matches when date field is within specified time period
 *     - Requires unit: 'days' | 'hours' | 'minutes'
 *     - Example: within 7 days = createdAt >= (now - 7 days)
 *
 * 12. INCLUDES_ANY / INCLUDES_ALL / INCLUDES_NONE (arrays - segments only, custom data fields)
 *     - The value is a list of values (a single value counts as a list of one)
 *     - INCLUDES_ANY: the field is an array holding at least one of them
 *     - INCLUDES_ALL: the field is an array holding every one of them
 *     - INCLUDES_NONE: the field is an array holding none of them; does NOT match a missing field
 *       or one that is not an array (OR[includesNone, notExists] adds missing and null fields)
 *     - Items compare as JSON values: the string "1" does not match the number 1
 */

/**
 * Example: Finding contacts without a field vs with a different value
 *
 * To find contacts where plan is NOT "basic":
 * - Use: { field: 'data.plan', operator: 'notEquals', value: 'basic' }
 * - Result: Matches contacts with plan='premium', plan='free', etc.
 * - Does NOT match: Contacts without plan field
 *
 * To find contacts WITHOUT a plan field:
 * - Use: { field: 'data.plan', operator: 'notExists' }
 * - Result: Matches contacts where plan is undefined or null
 *
 * To find contacts where plan is NOT "basic" OR plan doesn't exist:
 * - Use: OR[
 *     { field: 'data.plan', operator: 'notEquals', value: 'basic' },
 *     { field: 'data.plan', operator: 'notExists' }
 *   ]
 * - Result: Matches all except contacts with plan='basic'
 */
