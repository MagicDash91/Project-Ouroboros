{{ config(materialized='view') }}
select "channel_id"::integer as channel_id, trim("channel_name") as channel_name, trim("description") as description, "price_factor"::numeric as price_factor from {{ source('raw', 'sales_channels') }}
