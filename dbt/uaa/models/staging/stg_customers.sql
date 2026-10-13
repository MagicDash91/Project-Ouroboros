{{ config(materialized='view') }}
select "customer_id"::integer as customer_id, trim("customer_name") as customer_name, trim("gender") as gender, "age"::integer as age, trim("segment") as segment, "region_id"::integer as region_id, "signup_date"::date as signup_date, ("is_member"::integer = 1) as is_member from {{ source('raw', 'customers') }}
