import { luaString } from './lua-table.js';
import { CHINESE_LOCALE, tableLocales, type TablePatch, type TableTarget } from './table.js';

function studioSetup(target: TableTarget, payload: object): string {
  return `local Http = game:GetService("HttpService")
local payload = Http:JSONDecode(${luaString(JSON.stringify(payload))})
assert(tostring(game.PlaceId) == ${luaString(target.placeId)} and not game:GetService("RunService"):IsRunning(), "Wrong Place or not in Studio edit mode")
local service = game:GetService("LocalizationService")
local nativeTable
for _, child in service:GetChildren() do
    if child.Name == ${luaString(target.table)} then
        assert(not nativeTable and child:IsA("LocalizationTable"), "Ambiguous or invalid localization table")
        nativeTable = child
    end
end
assert(nativeTable, "LocalizationTable not found")
local function identity(key, source, context)
    return Http:JSONEncode({ key or "", source, context or "" })
end
local function report(data)
    return Http:JSONEncode(data)
end
`;
}

export function studioTableReadLuau(target: TableTarget, options: { sources?: string[]; missing?: boolean; locales?: string[] } = {}): string {
  return studioSetup(target, { ...target, locales: tableLocales(options.locales), sources: options.sources ?? [], missing: Boolean(options.missing) }) + `
local selected = {}
for _, source in payload.sources do selected[source] = true end
local byLocale, entries, found, seen = {}, {}, {}, {}
local total, matching, missingEntries = 0, 0, 0
local sourceLocale = nativeTable.SourceLocaleId:lower()
local locales = {}
for _, locale in payload.locales do
    if locale ~= sourceLocale and not (sourceLocale:match("^en%-") and locale == "en") then
        table.insert(locales, locale)
        byLocale[locale] = 0
    end
end
for _, entry in nativeTable:GetEntries() do
    total += 1
    local key, source, context = entry.Key or "", entry.Source, entry.Context or ""
    local id = identity(key, source, context)
    assert(not seen[id], "Duplicate Key/Source/Context: " .. id)
    seen[id] = true
    if not next(selected) or selected[source] then
        matching += 1
        found[source] = true
        local hasMissing = false
        local values = entry.Values
        for _, locale in locales do
            if not values[locale] or not values[locale]:find("%S") then
                byLocale[locale] += 1
                hasMissing = true
            end
        end
        if hasMissing then missingEntries += 1 end
        if (not payload.missing and next(selected)) or (payload.missing and hasMissing) then
            local visible = values
            if payload.missing then
                visible = { [${luaString(CHINESE_LOCALE)}] = values[${luaString(CHINESE_LOCALE)}] }
                for _, locale in locales do
                    visible[locale] = values[locale]
                end
            end
            table.insert(entries, { key = key, source = source, context = context, values = visible })
        end
    end
end
local notFound = {}
for _, source in payload.sources do
    if not found[source] then table.insert(notFound, source) end
end
return report({
    placeId = payload.placeId, table = payload.table, sourceLocale = sourceLocale, locales = locales,
    total = total, matching = matching, missingEntries = missingEntries,
    missingByLocale = byLocale, entries = entries, notFound = notFound,
})
`;
}

export function studioTableWriteLuau(patch: TablePatch, dryRun = false): string {
  const payload = {
    dryRun,
    entries: patch.entries.map(({ key, source, context, values, expected, expectedZh }) => ({
      key, source, context, expectedZh,
      changes: Object.entries(values).map(([locale, text]) => ({
        locale, text, absent: expected[locale] === null, expected: expected[locale] ?? '',
      })),
    })),
  };
  return studioSetup(patch, payload) + `
local function index(rows)
    local indexed = {}
    for _, entry in rows do
        local id = identity(entry.Key, entry.Source, entry.Context)
        assert(not indexed[id], "Duplicate Key/Source/Context: " .. id)
        indexed[id] = entry.Values
    end
    return indexed
end
local previous = nativeTable:GetEntries()
local existing = index(previous)
local conflicts, pending = {}, {}
local added, modified, unchanged = 0, 0, 0
local sourceLocale = nativeTable.SourceLocaleId:lower()
for _, row in payload.entries do
    local id = identity(row.key, row.source, row.context)
    local old = existing[id] or {}
    local changed = false
    if row.expectedZh ~= nil and old[${luaString(CHINESE_LOCALE)}] ~= row.expectedZh then
        table.insert(conflicts, { key = row.key, source = row.source, context = row.context, locale = ${luaString(CHINESE_LOCALE)}, reason = "translation hint changed" })
    end
    for _, change in row.changes do
        local actual = old[change.locale]
        if change.locale == sourceLocale or (sourceLocale:match("^en%-") and change.locale == "en") then
            table.insert(conflicts, { key = row.key, source = row.source, context = row.context, locale = change.locale, reason = "cannot write the source locale" })
        elseif actual == change.text then
            unchanged += 1
        elseif (change.absent and actual ~= nil) or (not change.absent and actual ~= change.expected) then
            table.insert(conflicts, { key = row.key, source = row.source, context = row.context, locale = change.locale, reason = "translation changed", actual = actual })
        else
            changed = true
            table.insert(pending, { row = row, change = change, id = id })
        end
    end
    if changed then
        if existing[id] then modified += 1 else added += 1 end
    end
end
if #conflicts > 0 then
    return report({ status = "conflict", conflicts = conflicts })
end
if not payload.dryRun and #pending > 0 then
    local ok, err = pcall(function()
        for _, item in pending do
            local row, change = item.row, item.change
            nativeTable:SetEntryValue(row.key, row.source, row.context, change.locale, change.text)
        end
        local after = index(nativeTable:GetEntries())
        for _, item in pending do
            assert(after[item.id] and after[item.id][item.change.locale] == item.change.text, "Translation readback mismatch: " .. item.id)
        end
    end)
    if not ok then
        local restored, restoreError = pcall(nativeTable.SetEntries, nativeTable, previous)
        if not restored then error(tostring(err) .. " ; rollback failed: " .. tostring(restoreError)) end
        error(err)
    end
end
return report({
    status = if payload.dryRun then "preview" else "verified",
    addedEntries = added, modifiedEntries = modified, updatedValues = #pending, unchangedValues = unchanged,
})
`;
}
