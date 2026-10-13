{{ config(materialized='view') }}
select "region_id"::integer as region_id, trim("province") as province, trim("island") as island, trim("city_tier") as city_tier from {{ source('raw', 'regions') }}
