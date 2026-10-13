{{ config(materialized='view') }}
select "product_id"::integer as product_id, trim("product_name") as product_name, trim("category") as category, trim("brand") as brand, "list_price"::numeric as list_price, "unit_cost"::numeric as unit_cost from {{ source('raw', 'products') }}
