-- Allow ADR deletion even when feature requests link to the ADR.
-- Junction rows are removed with the ADR; feature_requests themselves are kept.

ALTER TABLE feature_request_adrs
  DROP CONSTRAINT IF EXISTS feature_request_adrs_adr_id_fkey;

ALTER TABLE feature_request_adrs
  ADD CONSTRAINT feature_request_adrs_adr_id_fkey
  FOREIGN KEY (adr_id) REFERENCES adrs(id) ON DELETE CASCADE;
