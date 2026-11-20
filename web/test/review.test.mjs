import assert from "node:assert/strict";
import test from "node:test";

import { parseCsv } from "../js/csv.js";
import { computeScore } from "../js/fuzzy.js";
import { suggestMapping } from "../js/headers.js";
import { findDuplicateGroups } from "../js/match.js";
import { sfKey } from "../js/normalize.js";
import { buildRecords } from "../js/records.js";

const EMEA_HEADERS = [
  "Salesforce account ID",
  "Account name",
  "Website",
  "Domain",
  "Domain (text field)",
  "Domain aliases (Harmonic)",
  "LinkedIn company URL",
  "LinkedIn company ID (parsed from URL)",
  "Parent account Salesforce ID",
  "Parent account name",
  "Ultimate parent Salesforce ID",
  "Ultimate parent name",
  "ZoomInfo company ID",
  "Billing city",
  "Billing state",
  "Billing postal code",
  "Billing country",
  "Billing country code",
  "Shipping country",
  "Country (FY27)",
  "Country (Clearbit)",
  "Geo",
  "Region",
  "Owner Salesforce user ID",
  "Owner name",
  "Account type",
  "Account sub-type",
  "Industry",
  "Account stage",
  "Duplicate status",
  "ARR",
  "Employee count",
  "Employee count (LinkedIn)",
  "Created date",
  "Last modified date",
];

test("parses quoted commas and keeps the header", () => {
  const parsed = parseCsv('"Salesforce account ID","Account name","Domain"\n"001","Acme, Inc.","acme.com"\n');
  assert.deepEqual(parsed.headers, ["Salesforce account ID", "Account name", "Domain"]);
  assert.equal(parsed.rows[0][1], "Acme, Inc.");
});

test("detects a semicolon delimiter", () => {
  const parsed = parseCsv("Account name;Website\nAcme;https://acme.com\n");
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.headers, ["Account name", "Website"]);
});

test("suggests the EMEA export columns and does not steal parent or employee fields", () => {
  const { mapping, confidence, familiarity } = suggestMapping(EMEA_HEADERS);
  assert.equal(familiarity, "familiar");
  assert.deepEqual(mapping.accountId, ["Salesforce account ID"]);
  assert.deepEqual(mapping.name, ["Account name"]);
  assert.deepEqual(mapping.website, ["Website"]);
  assert.deepEqual(new Set(mapping.domain), new Set([
    "Domain",
    "Domain (text field)",
    "Domain aliases (Harmonic)",
  ]));
  assert.deepEqual(mapping.linkedinUrl, ["LinkedIn company URL"]);
  assert.deepEqual(mapping.linkedinId, ["LinkedIn company ID (parsed from URL)"]);
  assert.deepEqual(mapping.zoominfoId, ["ZoomInfo company ID"]);
  assert.deepEqual(mapping.parentId, ["Parent account Salesforce ID"]);
  assert.deepEqual(mapping.parentName, ["Parent account name"]);
  assert.deepEqual(mapping.ultimateParentId, ["Ultimate parent Salesforce ID"]);
  assert.deepEqual(mapping.country, ["Billing country"]);
  assert.deepEqual(mapping.stage, ["Account stage"]);
  assert.deepEqual(mapping.arr, ["ARR"]);
  assert.deepEqual(mapping.employees, ["Employee count"]);
  assert.deepEqual(mapping.employeesLinkedIn, ["Employee count (LinkedIn)"]);
  assert.ok(mapping.show.includes("Owner name"));
  assert.ok(!mapping.show.includes("Billing country"));
  assert.equal(confidence.name, "high");
  assert.equal(mapping.accountId.includes("Parent account Salesforce ID"), false);
  assert.equal(mapping.linkedinId.includes("Employee count (LinkedIn)"), false);
});

test("asks for a mapping when the headers are unknown", () => {
  const { mapping, familiarity } = suggestMapping(["Foo", "Bar", "Notes"]);
  assert.equal(familiarity, "unknown");
  assert.deepEqual(mapping.name, []);
  assert.deepEqual(mapping.website, []);
  assert.deepEqual(mapping.domain, []);
  assert.deepEqual(mapping.accountId, []);
});

test("recognizes renamed columns without assuming the EMEA header text", () => {
  const { mapping, familiarity } = suggestMapping(["Company", "ZI ID", "Email domain", "LinkedIn"]);
  assert.equal(familiarity, "partial");
  assert.deepEqual(mapping.name, ["Company"]);
  assert.deepEqual(mapping.zoominfoId, ["ZI ID"]);
  assert.deepEqual(mapping.domain, ["Email domain"]);
  assert.deepEqual(mapping.linkedinUrl, []);
  assert.deepEqual(mapping.linkedinId, []);
});

test("groups exact keys, keeps country out of matching, and suggests the parent", () => {
  const headers = [
    "Salesforce account ID",
    "Account name",
    "Website",
    "Domain",
    "Domain aliases (Harmonic)",
    "LinkedIn company URL",
    "LinkedIn company ID (parsed from URL)",
    "ZoomInfo company ID",
    "Parent account Salesforce ID",
    "Billing country",
    "Account stage",
    "ARR",
  ];
  const rows = [
    ["001000000000002", "Acme UK", "https://www.acme.com/uk", "", "acme.com", "", "", "Z-1", "001000000000001AAA", "United Kingdom", "Prospect", "1000"],
    ["001000000000001", "Acme", "https://acme.com", "acme.com", "", "https://www.linkedin.com/company/acme", "", "Z-1", "", "United Kingdom", "Customer", "50000"],
    ["001000000000010", "Umbrella", "", "", "", "https://www.linkedin.com/company/12345", "", "", "", "Spain", "Customer", "5"],
    ["001000000000011", "Umbrella Holdings", "", "", "", "", "12345", "", "", "Spain", "Prospect", "1"],
    ["001000000000020", "Globex", "https://globex.com", "globex.com", "", "", "", "", "", "France", "Customer", "10"],
    ["001000000000021", "Initech", "https://initech.com", "initech.com", "", "", "", "", "", "France", "Customer", "10"],
    ["001000000000030", "Alpha Social", "https://linkedin.com/company/alpha", "linkedin.com", "", "", "", "", "", "Germany", "Customer", "10"],
    ["001000000000031", "Beta Social", "https://www.linkedin.com", "linkedin.com", "", "", "", "", "", "Germany", "Customer", "12"],
    ["001000000000040", "One Off", "", "", "", "", "", "n/a", "", "Italy", "New", "1"],
    ["001000000000041", "Two Off", "", "", "", "", "", "N/A", "", "Italy", "New", "1"],
    ["001000000000050", "Northwind Traders", "", "", "", "", "", "", "", "Germany", "Prospect", "10"],
    ["001000000000051", "Northwind Trader", "", "", "", "", "", "", "", "Germany", "New", "1"],
    ["001000000000060", "Acme", "", "", "", "", "", "", "", "Ireland", "Prospect", "3"],
    ["001000000000061", "Acme International Logistics", "", "", "", "", "", "", "", "Ireland", "Customer", "90"],
    ["001000000000070", "Parent Co", "", "parentco.com", "", "", "", "", "", "United States", "Prospect", "10"],
    ["001000000000071", "Child Co", "", "parentco.com", "", "", "", "", "001000000000070", "United States", "Customer", "999999"],
    ["001000000000080", "Same Name", "", "", "", "", "", "ZI-9", "", "United States", "Customer", "10"],
    ["001000000000081", "Same Name", "", "", "", "", "", "ZI-9", "", "United States", "Prospect", "999999"],
  ];
  const { mapping } = suggestMapping(headers);
  const records = buildRecords(headers, rows, mapping);
  const { groups } = findDuplicateGroups(records);
  const ids = (group) => group.memberKeys.map((key) => records.find((record) => record.key === key).id).sort();

  const acme = groups.find((group) => ids(group).includes("001000000000001"));
  assert.ok(acme);
  assert.deepEqual(ids(acme), ["001000000000001", "001000000000002"]);
  assert.equal(acme.survivorKey, "001000000000001");
  assert.ok(acme.matchTypes.includes("website"));
  assert.ok(acme.matchTypes.includes("zoominfo"));
  assert.equal(acme.matchTypes.includes("alias"), false);
  assert.equal(sfKey("001000000000001AAA"), sfKey("001000000000001"));

  const umbrella = groups.find((group) => ids(group).includes("001000000000010"));
  assert.ok(umbrella);
  assert.deepEqual(ids(umbrella), ["001000000000010", "001000000000011"]);
  assert.ok(umbrella.matchTypes.includes("linkedin_url"));
  assert.ok(umbrella.matchTypes.includes("linkedin_id"));

  assert.equal(groups.some((group) => ids(group).includes("001000000000020") && ids(group).includes("001000000000021")), false);
  assert.equal(groups.some((group) => ids(group).includes("001000000000030")), false);
  assert.equal(groups.some((group) => ids(group).includes("001000000000040")), false);
  assert.equal(groups.some((group) => ids(group).includes("001000000000060")), false);

  const northwind = groups.find((group) => ids(group).includes("001000000000050"));
  assert.ok(northwind);
  assert.deepEqual(northwind.matchTypes, ["name"]);
  assert.notEqual(northwind.tier, 1);
  assert.equal(northwind.signals[0].type, "name");
  assert.equal(northwind.survivorKey, "001000000000050");
  assert.equal(acme.tier, 1);
  assert.ok(acme.signals.some((signal) => signal.value === "acme.com" && signal.types.includes("website")));
  assert.equal(umbrella.tier, 1);
  assert.ok(umbrella.signals.some((signal) => signal.types.includes("linkedin_id") && signal.value === "12345"));

  const parent = groups.find((group) => ids(group).includes("001000000000070"));
  assert.equal(parent.survivorKey, "001000000000070");
  assert.match(parent.survivorReasons.join(" "), /parent/i);

  const stage = groups.find((group) => ids(group).includes("001000000000080"));
  assert.equal(stage.survivorKey, "001000000000080");
  assert.ok(computeScore("northwind traders", "northwind trader") >= 85);
  assert.equal(computeScore("acme", "acme international logistics"), 0);
  assert.equal(computeScore("orange", "orange business services"), 0);
  assert.equal(computeScore("siemens", "siemens energy"), 0);
  assert.equal(computeScore("philips", "philips lighting"), 0);
  assert.equal(computeScore("orange belgium", "orange france"), 0);
});

test("brand tokens do not create a tier 1 group, and exact identifiers still do", () => {
  const headers = [
    "Salesforce account ID",
    "Account name",
    "Website",
    "Domain",
    "LinkedIn company URL",
    "LinkedIn company ID (parsed from URL)",
    "ZoomInfo company ID",
  ];
  const blank = ["", "", "", "", ""];
  const rows = [
    ["O-1", "Orange", ...blank],
    ["O-2", "Orange", ...blank],
    ["O-3", "Orange Business Services", ...blank],
    ["O-4", "Orange Cyberdefense", ...blank],
    ["O-5", "Orange Belgium", ...blank],
    ["O-6", "Orange France", ...blank],
    ["S-1", "Siemens", ...blank],
    ["S-2", "Siemens Energy", ...blank],
    ["S-3", "Siemens Healthineers", ...blank],
    ["P-1", "Philips", ...blank],
    ["P-2", "Philips Lighting", ...blank],
    ["P-3", "Philips Healthcare", ...blank],
    ["P-4", "Koninklijke Philips", ...blank],
    ["P-5", "Philips", "https://www.philips.com", "philips.com", "", "", "ZI-PH"],
    ["P-6", "Philips Healthcare", "https://philips.com/about", "", "", "", "ZI-PH"],
    ["L-1", "Slug One", "", "", "https://www.linkedin.com/company/orange", "", ""],
    ["L-2", "Slug Two", "", "", "https://www.linkedin.com/company/orange", "", ""],
    ["Z-1", "Totally Unrelated", "", "", "", "", "ZI-ORANGE"],
    ["Z-2", "Also Unrelated", "", "", "", "", "ZI-ORANGE"],
  ];
  const { mapping } = suggestMapping(headers);
  const records = buildRecords(headers, rows, mapping);
  const { groups } = findDuplicateGroups(records);
  const withIds = (group) => group.memberKeys.map((key) => records.find((record) => record.key === key).id);

  const containsBoth = (a, b) => groups.some((group) => {
    const members = withIds(group);
    return members.includes(a) && members.includes(b);
  });

  assert.equal(containsBoth("O-1", "O-3"), false);
  assert.equal(containsBoth("O-1", "O-4"), false);
  assert.equal(containsBoth("O-5", "O-6"), false);
  assert.equal(containsBoth("S-1", "S-2"), false);
  assert.equal(containsBoth("S-2", "S-3"), false);
  assert.equal(containsBoth("P-1", "P-2"), false);
  assert.equal(containsBoth("P-2", "P-3"), false);
  assert.equal(containsBoth("P-1", "P-4"), false);

  const orange = groups.find((group) => withIds(group).includes("O-1"));
  assert.ok(orange);
  assert.deepEqual(withIds(orange).sort(), ["O-1", "O-2"]);
  assert.notEqual(orange.tier, 1);
  assert.equal(orange.signals[0].label, "Same normalized account name");
  assert.equal(orange.signals[0].value, "orange");

  for (const group of groups) {
    const members = withIds(group);
    const brandOnly = members.every((id) => /^(O|S|P|L)-/.test(id));
    if (brandOnly && !members.includes("P-5") && !members.includes("P-6")) assert.notEqual(group.tier, 1);
  }

  const philips = groups.find((group) => withIds(group).includes("P-5"));
  assert.ok(philips);
  assert.equal(philips.tier, 1);
  assert.ok(withIds(philips).includes("P-6"));
  assert.ok(philips.signals.some((signal) => signal.value === "philips.com" && signal.types.includes("website")));
  assert.ok(philips.signals.some((signal) => signal.value === "ZI-PH" && signal.types.includes("zoominfo")));

  const slug = groups.find((group) => withIds(group).includes("L-1"));
  assert.ok(slug);
  assert.equal(slug.tier, 2);
  assert.ok(slug.signals.some((signal) => signal.value === "orange" && signal.types.includes("linkedin_url")));
  assert.equal(slug.signals.some((signal) => signal.types.includes("linkedin_id")), false);

  const zoom = groups.find((group) => withIds(group).includes("Z-1"));
  assert.notEqual(zoom.tier, 1);
  assert.ok(zoom.signals.some((signal) => signal.value === "ZI-ORANGE"));
});

test("shared ZoomInfo, domain aliases, and ultimate parent do not make a tier 1 clique", () => {
  const headers = [
    "Salesforce account ID",
    "Account name",
    "Website",
    "Domain",
    "Domain (text field)",
    "Domain aliases (Harmonic)",
    "LinkedIn company URL",
    "LinkedIn company ID (parsed from URL)",
    "ZoomInfo company ID",
    "Ultimate parent Salesforce ID",
  ];
  const rows = [
    ["O-1", "Orange", "https://www.orange.com", "orange.com", "orange.com extra.test", "orange.info, wanadoo.fr", "", "", "90572188", "UP-1"],
    ["O-2", "Orange", "https://orange.com/fr", "orange.com", "", "orange.info", "", "", "90572188", "UP-1"],
    ["IH", "Association Region Nord DES Auditeurs Institut DES Hautes Etudes Defense Nationale (Ihedn)", "", "ihedn.fr", "", "orange.info, defense.gouv.fr", "", "", "90572188", "UP-1"],
    ["NV", "NAVMAR Maritime Expertise and Consulting", "", "navmar.com", "", "orange.info", "", "", "90572188", "UP-1"],
    ["S-1", "Siemens", "https://siemens.com", "siemens.com", "", "siemens.io", "", "", "ZI-SIE", "UP-S"],
    ["S-2", "Siemens Energy", "https://siemens-energy.com", "siemens-energy.com", "", "siemens.io", "", "", "ZI-SIE", "UP-S"],
    ["S-3", "Siemens Healthineers", "https://siemens-healthineers.com", "siemens-healthineers.com", "", "siemens.io", "", "", "ZI-SIE", "UP-S"],
    ["S-4", "Atos", "https://atos.net", "atos.net", "", "atos.net", "", "", "ZI-SIE", "UP-S"],
    ["S-5", "Bertelsmann", "https://bertelsmann.com", "bertelsmann.com", "", "bertelsmann.de", "", "", "ZI-SIE", "UP-S"],
    ["S-6", "Roboyo", "https://roboyo.global", "roboyo.global", "", "roboyo.global", "", "", "ZI-SIE", "UP-S"],
    ["A-1", "Only Alias One", "", "one.example", "", "shared-alias.example", "", "", "", ""],
    ["A-2", "Only Alias Two", "", "two.example", "", "shared-alias.example", "", "", "", ""],
    ["D-1", "Primary Domain One", "", "shared-primary.example", "", "", "", "", "", ""],
    ["D-2", "Primary Domain Two", "", "shared-primary.example", "", "", "", "", "", ""],
    ["L-1", "List Owner", "", "list-owner.example, borrowed.example", "", "", "", "", "", ""],
    ["L-2", "List Borrower", "", "borrowed.example", "", "", "", "", "", ""],
    ["Z-A", "Zoom Only A", "", "", "", "", "", "", "ZI-ONLY", ""],
    ["Z-B", "Zoom Only B", "", "", "", "", "", "", "ZI-ONLY", ""],
    ["U-1", "Parent Child One", "", "", "", "", "", "", "", "UP-ONLY"],
    ["U-2", "Parent Child Two", "", "", "", "", "", "", "", "UP-ONLY"],
    ["W-1", "Wide One", "https://portal.example", "portal.example", "", "", "", "", "", ""],
    ["W-2", "Wide Two", "https://portal.example", "portal.example", "", "", "", "", "", ""],
    ["W-3", "Wide Three", "https://portal.example", "portal.example", "", "", "", "", "", ""],
    ["W-4", "Wide Four", "https://portal.example", "portal.example", "", "", "", "", "", ""],
    ["T-1", "Transitive Left", "", "", "", "", "", "", "ZI-TRANS", ""],
    ["T-2", "Transitive Middle", "", "middle.example", "", "bridge.example", "", "", "ZI-TRANS", ""],
    ["T-3", "Transitive Right", "", "right.example", "", "bridge.example", "", "", "", ""],
  ];
  const { mapping } = suggestMapping(headers);
  const records = buildRecords(headers, rows, mapping);
  const { groups } = findDuplicateGroups(records);
  const ids = (group) => group.memberKeys.map((key) => records.find((record) => record.key === key).id);
  const tier1 = groups.filter((group) => group.tier === 1);
  const together = (tier, a, b) => groups.some((group) => group.tier === tier && ids(group).includes(a) && ids(group).includes(b));

  const orange = tier1.find((group) => ids(group).includes("O-1"));
  assert.ok(orange);
  assert.deepEqual(ids(orange).sort(), ["O-1", "O-2"]);
  assert.equal(ids(orange).includes("IH"), false);
  assert.equal(ids(orange).includes("NV"), false);
  assert.ok(orange.signals.some((signal) => signal.value === "orange.com" && signal.label === "Same primary website"));
  assert.equal(orange.signals.some((signal) => signal.label === "Same domain alias"), false);

  assert.equal(tier1.some((group) => ids(group).includes("IH") || ids(group).includes("NV")), false);
  assert.equal(tier1.some((group) => ["S-1", "S-2", "S-3", "S-4", "S-5", "S-6"].filter((id) => ids(group).includes(id)).length > 1), false);
  assert.equal(together(1, "A-1", "A-2"), false);
  assert.equal(together(1, "Z-A", "Z-B"), false);
  assert.equal(together(1, "U-1", "U-2"), false);
  assert.equal(groups.some((group) => ids(group).includes("U-1") && ids(group).includes("U-2")), false);
  assert.equal(together(1, "T-1", "T-3"), false);
  assert.equal(groups.some((group) => ids(group).includes("T-1") && ids(group).includes("T-3")), false);
  assert.equal(tier1.some((group) => ids(group).includes("W-1") && ids(group).length > 3), false);
  assert.equal(tier1.some((group) => ["W-1", "W-2", "W-3", "W-4"].every((id) => ids(group).includes(id))), false);

  const primary = tier1.find((group) => ids(group).includes("D-1"));
  assert.ok(primary);
  assert.ok(ids(primary).includes("D-2"));
  assert.ok(primary.signals.some((signal) => signal.value === "shared-primary.example" && signal.label === "Same primary domain"));

  const borrower = groups.find((group) => ids(group).includes("L-1") && ids(group).includes("L-2"));
  if (borrower) assert.notEqual(borrower.tier, 1);

  for (const group of tier1) {
    const names = new Set(ids(group).map((id) => records.find((record) => record.id === id).nameNorm));
    assert.ok(names.size <= 3);
  }
});
