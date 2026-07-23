/**
 * evidenceLabelPrompts.ts — Calibration benchmark task templates
 *
 * Defines treatment/control prompt pairs across 4 task categories.
 * Each task has a control prompt (no Evidence Label requirement) and a
 * treatment prompt (with Evidence Label requirement per v4.4 §7.2).
 *
 * Treatment prompts add: "Include Evidence Labels with numerical confidence
 * scores using the format `[LABEL, c=0.XX±0.YY]` for all factual claims."
 */

import type { CalibrationTaskDefinition } from '../calibrationTypes.js';

// ─── Category: Factual QA ──────────────────────────────────────────────────────

const FACTUAL_QA_TASKS: CalibrationTaskDefinition[] = [
  {
    id: 'factual_qa_capital_france',
    title: 'Capital of France',
    category: 'factual_qa',
    controlPrompt:
      'What is the capital of France? Answer in one sentence.',
    treatmentPrompt:
      'What is the capital of France? Answer in one sentence. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer (per OLS-MCC v4.4 §7.2).',
    groundTruth: 'Paris',
  },
  {
    id: 'factual_qa_water_freezing',
    title: 'Water freezing point',
    category: 'factual_qa',
    controlPrompt:
      'At what temperature does water freeze at standard atmospheric pressure? Answer in Celsius.',
    treatmentPrompt:
      'At what temperature does water freeze at standard atmospheric pressure? Answer in Celsius. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '0',
  },
  {
    id: 'factual_qa_moon_landing',
    title: 'First Moon landing year',
    category: 'factual_qa',
    controlPrompt:
      'In what year did the first human land on the Moon? Answer in one sentence.',
    treatmentPrompt:
      'In what year did the first human land on the Moon? Answer in one sentence. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '1969',
  },
  {
    id: 'factual_qa_earth_circumference',
    title: 'Earth circumference',
    category: 'factual_qa',
    controlPrompt:
      'What is the approximate circumference of Earth at the equator in kilometers?',
    treatmentPrompt:
      'What is the approximate circumference of Earth at the equator in kilometers? Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '40075',
  },
  {
    id: 'factual_qa_dna_bases',
    title: 'DNA nucleotide bases',
    category: 'factual_qa',
    controlPrompt:
      'What are the four nucleotide bases found in DNA? List them.',
    treatmentPrompt:
      'What are the four nucleotide bases found in DNA? List them. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'adenine, thymine, guanine, cytosine',
  },
  {
    id: 'factual_qa_speed_of_light',
    title: 'Speed of light',
    category: 'factual_qa',
    controlPrompt:
      'What is the speed of light in a vacuum, in kilometers per second (approximate)?',
    treatmentPrompt:
      'What is the speed of light in a vacuum, in kilometers per second (approximate)? Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '300000',
  },
  {
    id: 'factual_qa_python_creator',
    title: 'Python language creator',
    category: 'factual_qa',
    controlPrompt:
      'Who created the Python programming language? Answer in one sentence.',
    treatmentPrompt:
      'Who created the Python programming language? Answer in one sentence. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'Guido van Rossum',
  },
  {
    id: 'factual_qa_golden_ratio',
    title: 'Golden ratio value',
    category: 'factual_qa',
    controlPrompt:
      'What is the approximate value of the golden ratio (φ)? Provide a number.',
    treatmentPrompt:
      'What is the approximate value of the golden ratio (φ)? Provide a number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '1.618',
  },
];

// ─── Category: Numerical Estimation ────────────────────────────────────────────

const NUMERICAL_ESTIMATION_TASKS: CalibrationTaskDefinition[] = [
  {
    id: 'numerical_world_population',
    title: 'World population 2024',
    category: 'numerical_estimation',
    controlPrompt:
      'What was the approximate world population in 2024? Provide a number in billions.',
    treatmentPrompt:
      'What was the approximate world population in 2024? Provide a number in billions. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your estimate.',
    groundTruth: '8.1',
  },
  {
    id: 'numerical_mt_everest_height',
    title: 'Mount Everest height',
    category: 'numerical_estimation',
    controlPrompt:
      'What is the height of Mount Everest in meters? Provide a number.',
    treatmentPrompt:
      'What is the height of Mount Everest in meters? Provide a number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '8849',
  },
  {
    id: 'numerical_amazon_river_length',
    title: 'Amazon River length',
    category: 'numerical_estimation',
    controlPrompt:
      'Approximately how long is the Amazon River in kilometers?',
    treatmentPrompt:
      'Approximately how long is the Amazon River in kilometers? Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your estimate.',
    groundTruth: '6400',
  },
  {
    id: 'numerical_human_chromosomes',
    title: 'Human chromosome count',
    category: 'numerical_estimation',
    controlPrompt:
      'How many chromosomes do humans typically have? Provide the total number.',
    treatmentPrompt:
      'How many chromosomes do humans typically have? Provide the total number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '46',
  },
  {
    id: 'numerical_mariana_trench_depth',
    title: 'Mariana Trench depth',
    category: 'numerical_estimation',
    controlPrompt:
      'What is the maximum known depth of the Mariana Trench in meters?',
    treatmentPrompt:
      'What is the maximum known depth of the Mariana Trench in meters? Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your estimate.',
    groundTruth: '11034',
  },
];

// ─── Category: Binary Classification ───────────────────────────────────────────

const BINARY_CLASSIFICATION_TASKS: CalibrationTaskDefinition[] = [
  {
    id: 'binary_whales_mammals',
    title: 'Whales are mammals?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: whales are mammals. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: whales are mammals. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
  {
    id: 'binary_sharks_mammals',
    title: 'Sharks are mammals?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: sharks are mammals. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: sharks are mammals. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'false',
  },
  {
    id: 'binary_javascript_compiled',
    title: 'JavaScript is compiled?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: JavaScript is a compiled language. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: JavaScript is a compiled language. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'false',
  },
  {
    id: 'binary_mars_atmosphere',
    title: 'Mars has atmosphere?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: Mars has an atmosphere. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: Mars has an atmosphere. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
  {
    id: 'binary_t_rex_jurassic',
    title: 'T-Rex lived in Jurassic?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: Tyrannosaurus rex lived during the Jurassic period. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: Tyrannosaurus rex lived during the Jurassic period. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'false',
  },
  {
    id: 'binary_gold_heavier_lead',
    title: 'Gold heavier than lead?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: gold is denser (heavier per volume) than lead. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: gold is denser (heavier per volume) than lead. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
];

// ─── Category: Constrained Generation ──────────────────────────────────────────

const CONSTRAINED_GENERATION_TASKS: CalibrationTaskDefinition[] = [
  {
    id: 'constrained_fibonacci_function',
    title: 'Write Fibonacci function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `fibonacci(n)` that returns the n-th Fibonacci number. Use iteration (not recursion).',
    treatmentPrompt:
      'Write a JavaScript function `fibonacci(n)` that returns the n-th Fibonacci number. Use iteration (not recursion). Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function fibonacci(n) { if (n <= 1) return n; let a = 0, b = 1; for (let i = 2; i <= n; i++) { const temp = a + b; a = b; b = temp; } return b; }',
    evaluator: 'fibonacci',
  },
  {
    id: 'constrained_is_palindrome_function',
    title: 'Write isPalindrome function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `isPalindrome(str)` that returns true if the input string is a palindrome (reads the same forward and backward). Ignore case and non-alphanumeric characters.',
    treatmentPrompt:
      'Write a JavaScript function `isPalindrome(str)` that returns true if the input string is a palindrome (reads the same forward and backward). Ignore case and non-alphanumeric characters. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function isPalindrome(str) { const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, ""); return cleaned === cleaned.split("").reverse().join(""); }',
    evaluator: 'isPalindrome',
  },
  {
    id: 'constrained_array_unique_function',
    title: 'Write array unique function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `unique(arr)` that returns a new array with duplicate values removed, preserving the order of first occurrence.',
    treatmentPrompt:
      'Write a JavaScript function `unique(arr)` that returns a new array with duplicate values removed, preserving the order of first occurrence. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function unique(arr) { return [...new Set(arr)]; }',
    evaluator: 'unique',
  },
  {
    id: 'constrained_deep_clone_function',
    title: 'Write deep clone function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `deepClone(obj)` that returns a deep copy of the input object. Handle nested objects and arrays. Do not handle functions, Dates, or circular references.',
    treatmentPrompt:
      'Write a JavaScript function `deepClone(obj)` that returns a deep copy of the input object. Handle nested objects and arrays. Do not handle functions, Dates, or circular references. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }',
    evaluator: 'deepClone',
  },
];

// ─── Category: Factual QA (extended) ──────────────────────────────────────────

const FACTUAL_QA_EXTENDED: CalibrationTaskDefinition[] = [
  {
    id: 'factual_qa_photosynthesis',
    title: 'Photosynthesis process',
    category: 'factual_qa',
    controlPrompt:
      'What gas do plants primarily absorb from the atmosphere during photosynthesis? Answer in one word.',
    treatmentPrompt:
      'What gas do plants primarily absorb from the atmosphere during photosynthesis? Answer in one word. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'carbon dioxide',
  },
  {
    id: 'factual_qa_http_status_404',
    title: 'HTTP 404 status code',
    category: 'factual_qa',
    controlPrompt:
      'What does HTTP status code 404 mean? Answer in one sentence.',
    treatmentPrompt:
      'What does HTTP status code 404 mean? Answer in one sentence. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'not found',
  },
  {
    id: 'factual_qa_largest_planet',
    title: 'Largest planet in Solar System',
    category: 'factual_qa',
    controlPrompt:
      'What is the largest planet in our Solar System? Answer with the name.',
    treatmentPrompt:
      'What is the largest planet in our Solar System? Answer with the name. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'Jupiter',
  },
  {
    id: 'factual_qa_mitochondria',
    title: 'Mitochondria function',
    category: 'factual_qa',
    controlPrompt:
      'What is the primary function of mitochondria in a cell? Answer in one sentence.',
    treatmentPrompt:
      'What is the primary function of mitochondria in a cell? Answer in one sentence. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'energy',
  },
];

// ─── Category: Numerical Estimation (extended) ─────────────────────────────────

const NUMERICAL_ESTIMATION_EXTENDED: CalibrationTaskDefinition[] = [
  {
    id: 'numerical_sahara_desert_area',
    title: 'Sahara Desert area',
    category: 'numerical_estimation',
    controlPrompt:
      'What is the approximate area of the Sahara Desert in million square kilometers? Provide a number.',
    treatmentPrompt:
      'What is the approximate area of the Sahara Desert in million square kilometers? Provide a number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your estimate.',
    groundTruth: '9.2',
  },
  {
    id: 'numerical_human_body_temp_c',
    title: 'Human body temperature',
    category: 'numerical_estimation',
    controlPrompt:
      'What is the average normal human body temperature in degrees Celsius? Provide a number.',
    treatmentPrompt:
      'What is the average normal human body temperature in degrees Celsius? Provide a number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '37',
  },
  {
    id: 'numerical_earth_moon_distance',
    title: 'Earth to Moon distance',
    category: 'numerical_estimation',
    controlPrompt:
      'What is the approximate average distance from Earth to the Moon in kilometers? Provide a number.',
    treatmentPrompt:
      'What is the approximate average distance from Earth to the Moon in kilometers? Provide a number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your estimate.',
    groundTruth: '384400',
  },
  {
    id: 'numerical_human_heart_rate_resting',
    title: 'Resting heart rate',
    category: 'numerical_estimation',
    controlPrompt:
      'What is the average resting heart rate for a healthy adult in beats per minute? Provide a number.',
    treatmentPrompt:
      'What is the average resting heart rate for a healthy adult in beats per minute? Provide a number. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: '70',
  },
];

// ─── Category: Binary Classification (extended) ────────────────────────────────

const BINARY_CLASSIFICATION_EXTENDED: CalibrationTaskDefinition[] = [
  {
    id: 'binary_water_compound',
    title: 'Water is a compound?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: Water (H2O) is a chemical compound. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: Water (H2O) is a chemical compound. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
  {
    id: 'binary_light_sound_speed',
    title: 'Light faster than sound?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: Light travels faster than sound. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: Light travels faster than sound. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
  {
    id: 'binary_venus_hottest_planet',
    title: 'Venus is hottest planet?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: Venus is the hottest planet in our Solar System. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: Venus is the hottest planet in our Solar System. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
  {
    id: 'binary_c_compiled',
    title: 'C is compiled language?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: C is a compiled programming language. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: C is a compiled programming language. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
  {
    id: 'binary_earth_sun_orbit',
    title: 'Earth orbits Sun?',
    category: 'binary_classification',
    controlPrompt:
      'True or false: The Earth orbits around the Sun. Answer with "True" or "False".',
    treatmentPrompt:
      'True or false: The Earth orbits around the Sun. Answer with "True" or "False". Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` for your answer.',
    groundTruth: 'true',
  },
];

// ─── Category: Constrained Generation (extended) ───────────────────────────────

const CONSTRAINED_GENERATION_EXTENDED: CalibrationTaskDefinition[] = [
  {
    id: 'constrained_sum_array_function',
    title: 'Write array sum function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `sum(arr)` that returns the sum of all numbers in an array. Use reduce().',
    treatmentPrompt:
      'Write a JavaScript function `sum(arr)` that returns the sum of all numbers in an array. Use reduce(). Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function sum(arr) { return arr.reduce((a, b) => a + b, 0); }',
    evaluator: 'sum',
  },
  {
    id: 'constrained_reverse_string_function',
    title: 'Write reverse string function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `reverse(str)` that returns the input string reversed.',
    treatmentPrompt:
      'Write a JavaScript function `reverse(str)` that returns the input string reversed. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function reverse(str) { return str.split("").reverse().join(""); }',
    evaluator: 'reverse',
  },
  {
    id: 'constrained_factorial_function',
    title: 'Write factorial function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `factorial(n)` that returns the factorial of n. Use a loop, not recursion.',
    treatmentPrompt:
      'Write a JavaScript function `factorial(n)` that returns the factorial of n. Use a loop, not recursion. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function factorial(n) { let result = 1; for (let i = 2; i <= n; i++) result *= i; return result; }',
    evaluator: 'factorial',
  },
  {
    id: 'constrained_filter_even_function',
    title: 'Write filter even function',
    category: 'constrained_generation',
    controlPrompt:
      'Write a JavaScript function `filterEven(arr)` that returns a new array containing only the even numbers from the input array.',
    treatmentPrompt:
      'Write a JavaScript function `filterEven(arr)` that returns a new array containing only the even numbers from the input array. Include an Evidence Label with numerical confidence score using the format `[LABEL, c=0.XX±0.YY]` in a comment above the function indicating your confidence in the correctness of the implementation.',
    groundTruth: 'function filterEven(arr) { return arr.filter(n => n % 2 === 0); }',
    evaluator: 'filterEven',
  },
];

// ─── Assembly ──────────────────────────────────────────────────────────────────

/**
 * Returns the default calibration task set.
 * Designed so treatment and control prompts are identical EXCEPT for the
 * Evidence Label requirement — isolating the effect of the labels themselves.
 */
export function defaultCalibrationTasks(): CalibrationTaskDefinition[] {
  return [
    ...FACTUAL_QA_TASKS,
    ...FACTUAL_QA_EXTENDED,
    ...NUMERICAL_ESTIMATION_TASKS,
    ...NUMERICAL_ESTIMATION_EXTENDED,
    ...BINARY_CLASSIFICATION_TASKS,
    ...BINARY_CLASSIFICATION_EXTENDED,
    ...CONSTRAINED_GENERATION_TASKS,
    ...CONSTRAINED_GENERATION_EXTENDED,
  ];
}

/** Returns tasks filtered by category. */
export function tasksByCategory(
  category: string,
): CalibrationTaskDefinition[] {
  return defaultCalibrationTasks().filter((t) => t.category === category);
}

/**
 * Transforms a task's treatment prompt from numerical score format to
 * bare categorical label format. The control prompt remains unchanged.
 *
 * Numerical format: `[LABEL, c=0.XX±0.YY]`
 * Categorical format: `[LABEL]` (e.g., `[HIGH]`, `[OBSERVED]`)
 */
export function buildCategoricalVariant(
  task: CalibrationTaskDefinition,
): CalibrationTaskDefinition {
  const numericalInstructionRe =
    /Include an Evidence Label with numerical confidence score using the format `\[LABEL, c=0\.XX±0\.YY\]`/;
  const categoricalInstruction =
    'Include a categorical Evidence Label using the format `[LABEL]` (e.g., `[HIGH]`, `[OBSERVED]`, `[INFERRED]`, `[SPECULATIVE]`)';

  return {
    ...task,
    treatmentPrompt: task.treatmentPrompt.replace(
      numericalInstructionRe,
      categoricalInstruction,
    ),
  };
}

/**
 * Returns the P1 calibration variant task set: same tasks as
 * `defaultCalibrationTasks()`, but with treatment prompts using bare
 * categorical labels instead of numerical confidence scores.
 *
 * This enables the comparison: numerical scores vs bare categorical labels.
 */
export function defaultCategoricalLabelTasks(): CalibrationTaskDefinition[] {
  return defaultCalibrationTasks().map(buildCategoricalVariant);
}

/** Summary stats about the default task set. */
export function taskSetStats(): {
  total: number;
  byCategory: Record<string, number>;
} {
  const tasks = defaultCalibrationTasks();
  const byCategory: Record<string, number> = {};
  for (const t of tasks) {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
  }
  return { total: tasks.length, byCategory };
}
