// Ported from graphiti (https://github.com/getzep/graphiti) at commit d50741d1bf463cbe3859eb73914cbff1b66839e6.
// Original file: graphiti_core/utils/maintenance/edge_operations.py. License: Apache-2.0. Copyright: Copyright 2024, Zep Software, Inc.
// Original file sha256: c98b606007d6490412c0fb3ec20482965a123a08987a7c1f48ae78ddeb718b75.
// This file is a translation of the original, not a copy.
// Modified for Stashpad: Python translated to JavaScript. Only the two date rules are kept, on memory fields valid_from and valid_to. expired_at has no equivalent and is dropped.
// Copyright 2024, Zep Software, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Translation notes (Stashpad): Python EntityEdge fields map to memory fields:
// valid_at -> valid_from, invalid_at -> valid_to. Graphiti's expired_at (system time)
// has no equivalent here; the audit log records changes instead. Dates are ISO strings.

// Returns a time in ms, null for a missing date. Throws for text that is not a date.
function toTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new TypeError(`not a date: ${value}`);
  return time;
}

// Expire the newer memory and any candidate it contradicts.
// Every check compares dates, so the caller must have dated the memory first.
// Mutates newer.valid_to and candidate.valid_to. Returns the candidates it invalidated.
export function applyTemporalInvalidation(newer, candidates) {
  // The memory arrived with an end date, so it is already historical.
  // Graphiti also sets expired_at here; Stashpad has no such field.
  if (!newer.valid_to) {
    // A candidate that starts later supersedes this memory, so end this one instead.
    const sorted = [...candidates].sort((a, b) => {
      const aMissing = toTime(a.valid_from) === null;
      const bMissing = toTime(b.valid_from) === null;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      return (toTime(a.valid_from) ?? 0) - (toTime(b.valid_from) ?? 0);
    });
    for (const candidate of sorted) {
      const candidateStart = toTime(candidate.valid_from);
      const newerStart = toTime(newer.valid_from);
      if (candidateStart !== null && newerStart !== null && candidateStart > newerStart) {
        newer.valid_to = candidate.valid_from;
        break;
      }
    }
  }
  return resolveEdgeContradictions(newer, candidates);
}

// The earlier memory is ended when it started before the newer one and the two overlap.
// Pairs that do not overlap are left alone.
export function resolveEdgeContradictions(newer, candidates) {
  if (candidates.length === 0) return [];

  const invalidated = [];
  for (const edge of candidates) {
    const edgeEnd = toTime(edge.valid_to);
    const edgeStart = toTime(edge.valid_from);
    const newerStart = toTime(newer.valid_from);
    const newerEnd = toTime(newer.valid_to);

    // The earlier memory ended before the newer one starts, or the newer one ended before the earlier one starts.
    if ((edgeEnd !== null && newerStart !== null && edgeEnd <= newerStart) ||
        (edgeStart !== null && newerEnd !== null && newerEnd <= edgeStart)) {
      continue;
    }
    // The newer memory invalidates the earlier one.
    if (edgeStart !== null && newerStart !== null && edgeStart < newerStart) {
      edge.valid_to = newer.valid_from;
      invalidated.push(edge);
    }
  }
  return invalidated;
}
