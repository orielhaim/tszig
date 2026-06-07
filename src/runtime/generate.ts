export function generateRuntime(): string {
  return `const std = @import("std");

/// Runtime helpers for tszig generated code.

/// Concatenate two strings using an allocator.
pub fn concat(allocator: std.mem.Allocator, a: []const u8, b: []const u8) []const u8 {
    const result = allocator.alloc(u8, a.len + b.len) catch return "";
    @memcpy(result[0..a.len], a);
    @memcpy(result[a.len..], b);
    return result;
}

/// Convert a number (f64) to a string.
pub fn numberToString(allocator: std.mem.Allocator, value: f64) []const u8 {
    return std.fmt.allocPrint(allocator, "{d}", .{value}) catch return "NaN";
}

/// Convert a boolean to a string.
pub fn boolToString(value: bool) []const u8 {
    return if (value) "true" else "false";
}

/// Check if a string contains a substring.
pub fn stringIncludes(haystack: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, haystack, needle) != null;
}

/// Get a substring (slice).
pub fn stringSlice(s: []const u8, start: usize, end: usize) []const u8 {
    const actual_end = if (end > s.len) s.len else end;
    const actual_start = if (start > actual_end) actual_end else start;
    return s[actual_start..actual_end];
}

/// Repeat a string n times.
pub fn stringRepeat(allocator: std.mem.Allocator, s: []const u8, count: usize) []const u8 {
    if (count == 0) return "";
    const result = allocator.alloc(u8, s.len * count) catch return "";
    var i: usize = 0;
    while (i < count) : (i += 1) {
        @memcpy(result[i * s.len .. (i + 1) * s.len], s);
    }
    return result;
}

/// Convert an integer (from f64) to usize safely.
pub fn toUsize(value: f64) usize {
    if (value < 0) return 0;
    return @intFromFloat(value);
}

/// Math.floor
pub fn floor(value: f64) f64 {
    return @floor(value);
}

/// Math.ceil
pub fn ceil(value: f64) f64 {
    return @ceil(value);
}

/// Math.abs
pub fn abs(value: f64) f64 {
    return @abs(value);
}
`;
}
