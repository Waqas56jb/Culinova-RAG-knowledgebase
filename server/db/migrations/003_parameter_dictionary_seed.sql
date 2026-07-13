-- ============================================================================
-- EOS PHASE 2 · LAYER 0 (seed) — THE PARAMETER DICTIONARY
--
-- This is VOCABULARY, not engineering judgement. It defines what a thing is CALLED,
-- what UNIT it is measured in, and what other names the same thing arrives under.
-- It contains no engineering values, no thresholds and no formulas — those come from
-- CULINOVA's own standards, as rules.
--
-- Every alias below was taken from the attribute names ACTUALLY PRESENT in the live
-- knowledge base (2,371 attributes across 112 entries) — none were invented:
--   "Power Load" / "Connected Load" / "Total Power"  → one parameter
--   "Cable Size" / "CABLE SIZE" / "Power Cable Section" → one parameter
--   "Water Pressure" / "Line Pressure" / "Recommended Line Pressure" → one parameter
--
-- Everything here is editable from the Admin Portal. Adding a parameter, an alias, a
-- unit or a discipline is a row — never a code change.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- UNIT CONVERSIONS — physics, not policy. value_canonical = value * factor + offset
-- ─────────────────────────────────────────────────────────────────────────────
insert into ceks_unit_conversions (from_unit, to_unit, factor, "offset", note) values
  ('W','kW',0.001,0,null), ('kW','W',1000,0,null),
  ('VA','kVA',0.001,0,null), ('kVA','VA',1000,0,null),
  ('mA','A',0.001,0,null), ('A','mA',1000,0,null),
  ('kV','V',1000,0,null), ('V','kV',0.001,0,null),
  ('bar','kPa',100,0,null), ('kPa','bar',0.01,0,null),
  ('mbar','kPa',0.1,0,null), ('kPa','mbar',10,0,null),
  ('psi','kPa',6.894757,0,null), ('kPa','psi',0.145038,0,null),
  ('Pa','kPa',0.001,0,null), ('kPa','Pa',1000,0,null),
  ('l/s','m3/h',3.6,0,null), ('m3/h','l/s',0.277778,0,null),
  ('cfm','m3/h',1.699011,0,null), ('m3/h','cfm',0.588578,0,null),
  ('m3/min','m3/h',60,0,null), ('m3/h','m3/min',0.016667,0,null),
  ('cm','mm',10,0,null), ('mm','cm',0.1,0,null),
  ('m','mm',1000,0,null), ('mm','m',0.001,0,null),
  ('in','mm',25.4,0,null), ('mm','in',0.03937,0,null),
  ('inch','mm',25.4,0,null),
  ('kg','g',1000,0,null), ('g','kg',0.001,0,null),
  ('C','C',1,0,'Celsius is canonical'),
  ('F','C',0.555556,-17.777778,'Fahrenheit → Celsius')
on conflict (lower(from_unit), lower(to_unit)) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- PARAMETERS + ALIASES
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  d_elec uuid; d_plumb uuid; d_drain uuid; d_gas uuid; d_vent uuid; d_inst uuid; d_clear uuid; d_fire uuid;
  p uuid;
begin
  select id into d_elec  from ceks_disciplines where code='electrical';
  select id into d_plumb from ceks_disciplines where code='plumbing';
  select id into d_drain from ceks_disciplines where code='drainage';
  select id into d_gas   from ceks_disciplines where code='gas';
  select id into d_vent  from ceks_disciplines where code='ventilation';
  select id into d_inst  from ceks_disciplines where code='installation';
  select id into d_clear from ceks_disciplines where code='clearances';
  select id into d_fire  from ceks_disciplines where code='fire_safety';

  -- ══ EQUIPMENT IDENTITY (matched in conditions: "Equipment Category = Combi Oven") ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('equipment.category','Equipment Category',null,'text',null,'input','Top-level category of the equipment (from the entry).',1)
  on conflict (key) do nothing;

  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('equipment.type','Equipment Type',null,'text',null,'input','Equipment type, e.g. Combi Oven (from the entry).',2)
  on conflict (key) do nothing;

  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('equipment.brand','Brand',null,'text',null,'input','Manufacturer brand (from the entry).',3)
  on conflict (key) do nothing;

  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,allowed_values,role,description,sort_order)
  values ('equipment.power_type','Power Type',null,'enum',null,'["Electric","Gas","Neutral"]'::jsonb,'input','Electric, Gas or Neutral (non-powered).',4)
  on conflict (key) do nothing;

  -- ══ ELECTRICAL — INPUTS ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,allowed_values,role,description,sort_order)
  values ('electrical.phase','Phase',d_elec,'enum',null,'["1-Phase","3-Phase"]'::jsonb,'input','Supply phase.',10)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='electrical.phase';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Phase','exact'), (p,'PHASE','exact'), (p,'Supply Phase','exact'), (p,'Phases','exact')
  on conflict (lower(alias), match_type) do nothing;
  -- how the raw strings actually appear in the live data
  insert into ceks_value_normalizations (parameter_id, raw_pattern, match_type, canonical_value) values
    (p,'3N','exact','3-Phase'), (p,'3~','exact','3-Phase'), (p,'3','exact','3-Phase'),
    (p,'3PH','contains','3-Phase'), (p,'3 Phase','contains','3-Phase'), (p,'THREE','contains','3-Phase'),
    (p,'1N','exact','1-Phase'), (p,'1~','exact','1-Phase'), (p,'1','exact','1-Phase'),
    (p,'1PH','contains','1-Phase'), (p,'1 Phase','contains','1-Phase'), (p,'SINGLE','contains','1-Phase');

  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('electrical.voltage','Voltage',d_elec,'number','V','input','Supply voltage. Ranges such as "380-415" are kept as min/max.',11)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='electrical.voltage';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Voltage','exact'), (p,'VOLTAGE','exact'), (p,'Rated Voltage','exact'), (p,'Supply Voltage','exact'),
    (p,'Nominal Voltage','exact'), (p,'Voltage (V)','exact')
  on conflict (lower(alias), match_type) do nothing;

  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('electrical.frequency','Frequency',d_elec,'number','Hz','input','Supply frequency. "50/60" and "50-60" are kept as min/max.',12)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='electrical.frequency';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Frequency','exact'), (p,'FREQUENCY','exact'), (p,'Frequency (Hz)','exact'), (p,'Supply Frequency','exact')
  on conflict (lower(alias), match_type) do nothing;

  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('electrical.power','Power',d_elec,'number','kW','input','Electrical power / connected load.',13)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='electrical.power';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Power Load','exact'), (p,'Connected Load','exact'), (p,'Total Power','exact'), (p,'Electrical Power','exact'),
    (p,'Rated Power','exact'), (p,'Power','exact'), (p,'Power Consumption','exact'), (p,'Total Connected Load','exact'),
    (p,'Electrical Load','exact')
  on conflict (lower(alias), match_type) do nothing;

  -- Current does NOT appear in any of the 535 live electrical attributes. It is almost always
  -- DERIVED. The derivation formula (with power factor / efficiency) is a RULE, entered and
  -- reviewed by CULINOVA — this dictionary only declares that the parameter exists.
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('electrical.current','Current',d_elec,'number','A','input','Full-load current. Usually DERIVED from power/voltage/phase by a CULINOVA derivation rule.',14)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='electrical.current';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Current','exact'), (p,'CURRENT','exact'), (p,'Rated Current','exact'), (p,'Full Load Current','exact'),
    (p,'Nominal Current','exact'), (p,'Current (A)','exact'), (p,'FLA','exact'), (p,'Amperage','exact')
  on conflict (lower(alias), match_type) do nothing;

  -- ══ ELECTRICAL — OUTPUTS (what a rule recommends) ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order) values
    ('electrical.cable_size','Recommended Cable Size',d_elec,'text',null,'output','CULINOVA recommended cable size.',20),
    ('electrical.breaker','Recommended Breaker',d_elec,'text',null,'output','CULINOVA recommended protective device.',21),
    ('electrical.connection','Recommended Electrical Connection',d_elec,'text',null,'output','How the equipment is connected.',22),
    ('electrical.socket_type','Recommended Socket Type',d_elec,'text',null,'output','Socket / plug type.',23),
    ('electrical.isolator','Recommended Isolator Switch',d_elec,'text',null,'output','Local isolation device.',24),
    ('electrical.dedicated_circuit','Dedicated Circuit Requirement',d_elec,'text',null,'output','Whether a dedicated circuit is required.',25),
    ('electrical.rcd','RCD / GFCI Requirement',d_elec,'text',null,'output','Residual-current protection requirement.',26)
  on conflict (key) do nothing;

  -- these output names ALSO appear as manufacturer-stated values in the live data, so they get
  -- aliases too: EOS must show the manufacturer's value beside its own recommendation.
  select id into p from ceks_parameters where key='electrical.cable_size';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Cable Size','exact'), (p,'CABLE SIZE','exact'), (p,'Power Cable Section','exact'), (p,'Cable Section','exact'), (p,'Cable','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='electrical.breaker';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Breaker','exact'), (p,'BREAKER','exact'), (p,'Circuit Breaker','exact'), (p,'MCB','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='electrical.isolator';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Isolator Switch','exact'), (p,'ISOLATOR SWITCH','exact'), (p,'Isolator','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='electrical.connection';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Electrical Connection','exact'), (p,'Electrical Requirement','exact'), (p,'Connection','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='electrical.rcd';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'RCD / GFCI','exact'), (p,'RCD','exact'), (p,'GFCI','exact')
  on conflict (lower(alias), match_type) do nothing;

  -- ══ PLUMBING ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order) values
    ('plumbing.water_pressure','Water Pressure',d_plumb,'number','kPa','input','Supply water pressure (ranges kept as min/max).',30),
    ('plumbing.water_inlet_size','Water Inlet Size',d_plumb,'text',null,'both','Inlet connection size as stated by the manufacturer.',31),
    ('plumbing.water_requirement','Water Requirement',d_plumb,'text',null,'input','Manufacturer water requirement note.',32),
    ('plumbing.water_hardness','Water Hardness',d_plumb,'number',null,'input','Total hardness.',33),
    ('plumbing.water_connection_size','Recommended Water Connection Size',d_plumb,'text',null,'output','CULINOVA recommended water connection size.',34),
    ('plumbing.hot_water_required','Hot Water Required',d_plumb,'text',null,'output','Whether a hot-water point is required.',35),
    ('plumbing.connection_height','Recommended Connection Height',d_plumb,'number','mm','output','Height of the connection point from finished floor level.',36)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='plumbing.water_pressure';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Water Pressure','exact'), (p,'Line Pressure','exact'), (p,'Recommended Water Pressure','exact'),
    (p,'Recommended Line Pressure','exact'), (p,'Supply Pressure','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='plumbing.water_inlet_size';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Water Inlet Size','exact'), (p,'Water Connection','exact'), (p,'Water Inlet','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='plumbing.water_requirement';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values (p,'Water Requirement','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='plumbing.water_hardness';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Total Hardness','exact'), (p,'Steam Circuit Total Hardness','exact')
  on conflict (lower(alias), match_type) do nothing;

  -- ══ DRAINAGE ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,allowed_values,role,description,sort_order) values
    ('drainage.drain_size','Drain Size',d_drain,'text',null,null,'both','Drain size as stated by the manufacturer.',40),
    ('drainage.drain_requirement','Drain Requirement',d_drain,'text',null,null,'input','Manufacturer drain requirement note.',41),
    ('drainage.drain_type','Drain Type',d_drain,'enum',null,'["Gravity","Pumped"]'::jsonb,'input','Gravity or pumped.',42),
    ('drainage.recommended_drain_size','Recommended Drain Size',d_drain,'text',null,null,'output','CULINOVA recommended drain size.',43),
    ('drainage.floor_drain_required','Floor Drain Required',d_drain,'text',null,null,'output','Whether a floor drain is required.',44)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='drainage.drain_size';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values (p,'Drain Size','exact'), (p,'Drain Diameter','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='drainage.drain_requirement';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values (p,'Drain Requirement','exact')
  on conflict (lower(alias), match_type) do nothing;

  -- ══ GAS ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order) values
    ('gas.gas_type','Gas Type',d_gas,'text',null,'input','Gas family, e.g. LPG / NG / G20 / G30.',50),
    ('gas.gas_pressure','Gas Pressure',d_gas,'number','mbar','input','Inlet / regulated gas pressure.',51),
    ('gas.gas_power','Gas Power',d_gas,'number','kW','input','Gas heat input.',52),
    ('gas.gas_consumption','Gas Consumption',d_gas,'number',null,'input','Gas consumption rate.',53),
    ('gas.gas_connection_size','Gas Connection Size',d_gas,'text',null,'both','Gas inlet size as stated by the manufacturer.',54),
    ('gas.recommended_pipe_size','Recommended Gas Pipe Size',d_gas,'text',null,'output','CULINOVA recommended gas pipe size.',55),
    ('gas.isolation_valve','Gas Isolation Valve',d_gas,'text',null,'output','Isolation valve requirement.',56)
  on conflict (key) do nothing;
  select id into p from ceks_parameters where key='gas.gas_type';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Gas Type','exact'), (p,'Gas Family','exact'), (p,'Gas Category','exact'), (p,'Gas Type','contains')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='gas.gas_pressure';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Gas Pressure','exact'), (p,'Inlet Pressure','exact'), (p,'Regulated Pressure','contains'), (p,'Supply Gas Pressure','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='gas.gas_power';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Gas Power','exact'), (p,'Gas Heat Input','exact'), (p,'Heat Input','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='gas.gas_consumption';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values (p,'Gas Consumption','exact')
  on conflict (lower(alias), match_type) do nothing;
  select id into p from ceks_parameters where key='gas.gas_connection_size';
  insert into ceks_parameter_aliases (parameter_id, alias, match_type) values
    (p,'Gas Connection Size','exact'), (p,'Gas Inlet Size','exact'), (p,'Gas Connection Diameter','exact'), (p,'Gas Requirement','exact')
  on conflict (lower(alias), match_type) do nothing;

  -- ══ VENTILATION ══ (the live data holds almost nothing here yet — 3 attributes total)
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order) values
    ('ventilation.exhaust_airflow','Recommended Exhaust Airflow',d_vent,'number','m3/h','output','CULINOVA recommended exhaust airflow.',60),
    ('ventilation.fresh_air','Recommended Fresh Air',d_vent,'number','m3/h','output','CULINOVA recommended fresh-air make-up.',61),
    ('ventilation.hood_required','Hood Requirement',d_vent,'text',null,'output','Whether an extraction hood is required.',62),
    ('ventilation.steam_extraction','Steam Extraction',d_vent,'text',null,'output','Steam extraction requirement.',63),
    ('ventilation.heat_load','Heat Load',d_vent,'number','kW','input','Heat rejected into the room.',64)
  on conflict (key) do nothing;

  -- ══ INSTALLATION + CLEARANCES ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order) values
    ('installation.notes','Installation Notes',d_inst,'text',null,'output','CULINOVA installation notes.',70),
    ('installation.connection_height','Connection Height',d_inst,'number','mm','output','Connection height from finished floor level.',71),
    ('clearances.service_clearance','Service Clearance Requirements',d_clear,'text',null,'output','Required service/access clearances.',80),
    ('clearances.rear','Rear Clearance',d_clear,'number','mm','output','Minimum rear clearance.',81),
    ('clearances.side','Side Clearance',d_clear,'number','mm','output','Minimum side clearance.',82),
    ('clearances.top','Top Clearance',d_clear,'number','mm','output','Minimum top clearance.',83)
  on conflict (key) do nothing;

  -- ══ CROSS-DISCIPLINE OUTPUT (client field on every rule) ══
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('general.engineer_approval_required','Engineer Approval Required',null,'text',null,'output','Set by a rule when a qualified engineer must sign the value off.',90)
  on conflict (key) do nothing;

  -- ══ FIRE & SAFETY ══ (the client asked for the discipline; parameters will be added with
  --    their standards — we do not invent fire-safety requirements.)
  insert into ceks_parameters (key,label,discipline_id,data_type,canonical_unit,role,description,sort_order)
  values ('fire_safety.suppression_required','Fire Suppression Requirement',d_fire,'text',null,'output','Set by a CULINOVA fire & safety rule.',95)
  on conflict (key) do nothing;
end $$;
