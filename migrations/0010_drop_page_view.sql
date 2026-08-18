-- 访客统计口径已改为 play_log 的去重参与人数，page_view 表不再被任何查询消费，删除表与索引
DROP TABLE IF EXISTS page_view;
