{{ config(materialized='view') }}
select "order_id"::integer as order_id, "customer_id"::integer as customer_id, "channel_id"::integer as channel_id, "order_date"::date as order_date, trim("status") as status, trim("payment_method") as payment_method, "discount_pct"::numeric as discount_pct from {{ source('raw', 'orders') }}
